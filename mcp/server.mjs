#!/usr/bin/env node
// Entropy Design MCP server (zero-dependency, stdio JSON-RPC per MCP spec).
// Env: ED_PROJECT_DIR (project folder), ED_SETTINGS_FILE (settings.json path)

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import { generateKlingVideo, generateMiniMaxVideo, generateFalVideo, generateCustomVideo } from './video-providers.mjs'
import { generateOpenAISpeech, generateFalMusic } from './audio-providers.mjs'
import { createMediaTools, resolveMediaBins } from './media-tools.mjs'
import { createAnalyseTools } from './analyse-tools.mjs'
import { listWorkflows, loadWorkflow, fetchObjectInfo, describeWorkflow, runComfyWorkflow } from './comfy-tools.mjs'

const PROJECT_DIR = process.env.ED_PROJECT_DIR || process.cwd()
const SETTINGS_FILE = process.env.ED_SETTINGS_FILE || ''
const SERVER_URL = (process.env.ED_SERVER_URL || '').replace(/\/$/, '')
const ED_DIR = path.join(PROJECT_DIR, '.entropy')
const CANVAS_FILE = path.join(ED_DIR, 'canvas.json')
const SKILLS_DIR =
  process.env.ED_SKILLS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills')
// 用户技能文件夹（新建/编辑的技能都归档在这里），同名时覆盖内置
const USER_SKILLS_DIR = process.env.ED_USER_SKILLS_DIR || ''
const KNOWLEDGE_DIR =
  process.env.ED_KNOWLEDGE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge')
// official playbook scripts (P3-1): step-by-step choreographies heavier than a skill
const WORKFLOWS_DIR =
  process.env.ED_WORKFLOWS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows')
// per-project long-term memory cards (P3-3): brand preferences, adopted decisions
const MEMORY_DIR = path.join(ED_DIR, 'memory')

function parseSkillMeta(file) {
  const raw = fs.readFileSync(file, 'utf-8')
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  const meta = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())
      if (kv) meta[kv[1]] = kv[2].trim()
    }
  }
  return { meta, body: raw }
}

/** 扫描一个技能目录，兼容两种布局：<name>.md 平铺文件与 <name>/SKILL.md 技能文件夹。 */
function skillFilesInDir(dir) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      out.push({ file: path.join(dir, e.name), folder: null })
    } else if (e.isDirectory()) {
      const skill = path.join(dir, e.name, 'SKILL.md')
      if (fs.existsSync(skill)) out.push({ file: skill, folder: path.join(dir, e.name) })
    }
  }
  return out
}

function skillNameOf(entry) {
  const base = entry.folder ? path.basename(entry.folder) : path.basename(entry.file, '.md')
  try {
    return parseSkillMeta(entry.file).meta.name || base
  } catch {
    return base
  }
}

/**
 * 合并内置与用户技能：按名字去重，用户目录优先（同名覆盖内置）。
 * 返回 [{ name, file, source: 'user'|'builtin', overrides }]。
 */
function scanSkills() {
  const byName = new Map()
  for (const entry of skillFilesInDir(SKILLS_DIR)) {
    byName.set(skillNameOf(entry), { ...entry, source: 'builtin' })
  }
  if (USER_SKILLS_DIR) {
    for (const entry of skillFilesInDir(USER_SKILLS_DIR)) {
      const name = skillNameOf(entry)
      byName.set(name, { ...entry, source: 'user', overrides: byName.has(name) ? 'builtin' : undefined })
    }
  }
  return [...byName.entries()].map(([name, v]) => ({ name, ...v }))
}

// ---------- helpers ----------

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function emptyCanvas() {
  return { version: 1, mode: 'workflow', nodes: [], edges: [] }
}

function readCanvas() {
  try {
    return JSON.parse(fs.readFileSync(CANVAS_FILE, 'utf-8'))
  } catch {
    return emptyCanvas()
  }
}

function writeCanvas(doc) {
  fs.mkdirSync(ED_DIR, { recursive: true })
  const tmp = CANVAS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8')
  fs.renameSync(tmp, CANVAS_FILE)
}

function nextNodePos(doc, width = 320) {
  // place to the right of all nodes; wrap down when row is long
  const nodes = doc.nodes || []
  if (nodes.length === 0) return { x: 0, y: 0 }
  let maxX = -Infinity
  let maxY = -Infinity
  let rightMostY = 0
  for (const n of nodes) {
    const x = n.positions?.main?.x ?? 0
    const y = n.positions?.main?.y ?? 0
    if (x > maxX) {
      maxX = x
      rightMostY = y
    }
    if (y > maxY) maxY = y
  }
  if (maxX > 4000) return { x: 0, y: maxY + 460 }
  return { x: maxX + width + 60, y: rightMostY }
}

function addNode(doc, node) {
  doc.nodes = doc.nodes || []
  // createdAt stamps "this turn's outputs" for canvas_outputs_group
  node.data = { createdAt: new Date().toISOString(), ...(node.data || {}) }
  doc.nodes.push(node)
  writeCanvas(doc)
  return node
}

/** Link a generated node back to its source node (only when the source exists). */
function addEdgeToDoc(doc, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return
  if (!(doc.nodes || []).some((n) => n.id === sourceId)) return
  doc.edges = doc.edges || []
  const id = `e-${sourceId}-${targetId}`
  if (!doc.edges.some((e) => e.id === id)) doc.edges.push({ id, source: sourceId, target: targetId })
}

// ---------- grouping helpers (positions stay ABSOLUTE; renderer converts to parent-relative) ----------

const GRID_CELL_W = 420
const GRID_CELL_H = 340
const GROUP_PAD = 28
const GROUP_HEADER = 44

function groupMembers(doc, memberNodes, label) {
  let minX = Infinity
  let minY = Infinity
  for (const n of memberNodes) {
    minX = Math.min(minX, n.positions?.main?.x ?? 0)
    minY = Math.min(minY, n.positions?.main?.y ?? 0)
  }
  const cols = Math.ceil(Math.sqrt(memberNodes.length)) || 1
  const rows = Math.ceil(memberNodes.length / cols)
  const group = {
    id: 'group-' + crypto.randomUUID(),
    type: 'group',
    positions: { main: { x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEADER } },
    size: { width: cols * GRID_CELL_W + GROUP_PAD * 2, height: rows * GRID_CELL_H + GROUP_HEADER + GROUP_PAD * 2 },
    data: { createdAt: new Date().toISOString(), name: label || '本轮产出' }
  }
  doc.nodes.push(group)
  memberNodes.forEach((n, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const target = doc.nodes.find((x) => x.id === n.id)
    if (!target) return
    target.parentId = group.id
    target.positions = {
      main: {
        x: group.positions.main.x + GROUP_PAD + col * GRID_CELL_W,
        y: group.positions.main.y + GROUP_HEADER + GROUP_PAD + row * GRID_CELL_H
      }
    }
  })
  return group
}

function slugify(name) {
  const ext = path.extname(name || '') || '.png'
  const base = (path.basename(name || '', ext) || 'asset').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${base}-${stamp}${ext}`
}

function toText(s) {
  return { content: [{ type: 'text', text: s }] }
}

function toError(s) {
  return { content: [{ type: 'text', text: s }], isError: true }
}

// ---------- canvas tools ----------

const canvasTools = {
  canvas_nodes_list: {
    description:
      'List all nodes on the current project canvas with id, type, name, position and key data. Always call this first before canvas mutations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const doc = readCanvas()
      const summary = (doc.nodes || []).map((n) => ({
        id: n.id,
        type: n.type,
        name: n.data?.name,
        path: n.data?.path,
        position: n.positions?.main,
        grouped: n.type === 'group' ? undefined : !!n.parentId,
        text: n.type === 'text' ? (n.data?.text || '').slice(0, 400) : undefined
      }))
      return toText(JSON.stringify({ count: summary.length, nodes: summary }, null, 2))
    }
  },

  canvas_node_read: {
    description: 'Get full data of one canvas node by id.',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string', description: 'Canvas node id' } },
      required: ['node_id']
    },
    async run(args) {
      const doc = readCanvas()
      const node = (doc.nodes || []).find((n) => n.id === args.node_id)
      if (!node) return toError(`node not found: ${args.node_id}`)
      return toText(JSON.stringify(node, null, 2))
    }
  },

  canvas_node_add_text: {
    description:
      'Create a text node on the canvas (notes, briefs, prompts, plans). Returns the node id. Pass source_node_id to visually link it to the node it was derived from (lineage line).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Node title' },
        text: { type: 'string', description: 'Markdown text content' },
        source_node_id: { type: 'string', description: 'Canvas node id this text is derived from (draws a lineage line)' }
      },
      required: ['name', 'text']
    },
    async run(args) {
      const doc = readCanvas()
      const pos = nextNodePos(doc, 360)
      const node = {
        id: crypto.randomUUID(),
        type: 'text',
        positions: { main: pos },
        size: { width: 360, height: 240 },
        data: { name: args.name, text: args.text, sourceNodeId: args.source_node_id || undefined }
      }
      addEdgeToDoc(doc, args.source_node_id, node.id)
      addNode(doc, node)
      return toText(`text node created: id=${node.id} name="${node.data.name}"`)
    }
  },

  canvas_node_add_table: {
    description:
      'Create a table node on the canvas — the visual home for structured grids: storyboard 分镜表 (镜头/时长/画面/旁白/备注), shot lists, pricing sheets. ' +
      'Pass markdown cell bodies; they render as markdown. Returns the node id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Table title, e.g. 分镜表' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column headers (2-8)' },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Row cells; each row has the same length as columns'
        },
        source_node_id: { type: 'string', description: 'Canvas node id this table was derived from (draws a lineage line)' }
      },
      required: ['name', 'columns', 'rows']
    },
    async run(args) {
      const columns = (Array.isArray(args.columns) ? args.columns : []).map(String).slice(0, 8)
      if (columns.length < 2) return toError('canvas_node_add_table needs at least 2 columns')
      const rows = (Array.isArray(args.rows) ? args.rows : [])
        .slice(0, 60)
        .map((r) => (Array.isArray(r) ? r.map(String) : []))
        .map((r) => {
          const row = r.slice(0, columns.length)
          while (row.length < columns.length) row.push('')
          return row
        })
      const doc = readCanvas()
      const pos = nextNodePos(doc, 520)
      const node = {
        id: crypto.randomUUID(),
        type: 'table',
        positions: { main: pos },
        size: { width: 520, height: Math.min(640, 96 + rows.length * 34) },
        data: { name: String(args.name || '表格'), table: { columns, rows }, sourceNodeId: args.source_node_id || undefined }
      }
      addEdgeToDoc(doc, args.source_node_id, node.id)
      addNode(doc, node)
      return toText(`table node created: id=${node.id} name="${node.data.name}" columns=${columns.length} rows=${rows.length}`)
    }
  },

  canvas_text_patch: {
    description:
      'Edit an existing TEXT node incrementally (storyboard iteration without rewriting the whole brief). ' +
      'Each edit replaces ALL occurrences of `find` with `replace`; the edit batch fails atomically if any `find` is absent. ' +
      'Pass an empty replace to delete the matched text.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Target text node id' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact substring to replace' },
              replace: { type: 'string', description: 'Replacement text (empty = delete)' }
            },
            required: ['find']
          },
          description: 'Ordered edits (1-20)'
        }
      },
      required: ['node_id', 'edits']
    },
    async run(args) {
      const doc = readCanvas()
      const node = (doc.nodes || []).find((n) => n.id === args.node_id)
      if (!node) return toError(`node not found: ${args.node_id}`)
      if (node.type !== 'text') return toError(`canvas_text_patch only edits text nodes; "${node.data?.name || node.id}" is ${node.type}`)
      const edits = Array.isArray(args.edits) ? args.edits.slice(0, 20) : []
      if (edits.length === 0) return toError('edits requires at least one {find, replace}')
      let text = String(node.data?.text ?? '')
      for (const [i, e] of edits.entries()) {
        const find = String(e?.find ?? '')
        if (!find) return toError(`edit ${i + 1}: empty find string`)
        if (!text.includes(find)) return toError(`edit ${i + 1} not applied: text does not contain "${find.slice(0, 60)}" — nothing was changed (batch is atomic)`)
        text = text.split(find).join(String(e?.replace ?? ''))
      }
      node.data = { ...node.data, text }
      writeCanvas(doc)
      return toText(`text node updated: id=${node.id} edits=${edits.length}`)
    }
  },

  canvas_node_add_file: {
    description:
      'Import an existing file (image/video/audio/any) into the project folder and add a canvas node for it. Pass source_node_id to visually link it to the node it was derived from (lineage line). ' +
      'Idempotent by content: importing a file whose bytes already exist on the canvas reuses the existing node (returns "node reused") instead of duplicating.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Absolute path of the source file' },
        name: { type: 'string', description: 'Display name (defaults to file name)' },
        source_node_id: { type: 'string', description: 'Canvas node id this file is derived from (draws a lineage line)' }
      },
      required: ['source_path']
    },
    async run(args) {
      const src = args.source_path
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return toError(`file not found: ${src}`)
      const ext = path.extname(src).toLowerCase()
      const type = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp'].includes(ext)
        ? 'image'
        : ['.mp4', '.webm', '.mov'].includes(ext)
          ? 'video'
          : ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)
            ? 'audio'
            : 'file'
      // content dedupe: same bytes already on canvas → reuse the node (no overwrite, no duplicate)
      const sourceHash = crypto.createHash('md5').update(fs.readFileSync(src)).digest('hex')
      const doc = readCanvas()
      const existing = (doc.nodes || []).find((n) => n.data?.sourceHash === sourceHash && n.data?.path && fs.existsSync(path.join(PROJECT_DIR, n.data.path)))
      if (existing) {
        addEdgeToDoc(doc, args.source_node_id, existing.id)
        writeCanvas(doc)
        return toText(`node reused: id=${existing.id} file="${existing.data.path}" (duplicate import skipped)`)
      }
      const fname = slugify(args.name || path.basename(src))
      const destRel = path.join('assets', fname)
      const dest = path.join(PROJECT_DIR, destRel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      const pos = nextNodePos(doc)
      const node = {
        id: crypto.randomUUID(),
        type,
        positions: { main: pos },
        data: { name: args.name || path.basename(src), path: destRel.split(path.sep).join('/'), sourceNodeId: args.source_node_id || undefined, sourceHash }
      }
      addEdgeToDoc(doc, args.source_node_id, node.id)
      addNode(doc, node)
      return toText(`${type} node created: id=${node.id} file="${destRel}"`)
    }
  },

  canvas_selection_read: {
    description:
      'Get the nodes the user currently selected on the canvas (selection-first workflow: "this image" / "the selected node" refers to this). Returns [] when nothing is selected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      let ids = []
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(ED_DIR, 'selection.json'), 'utf-8'))
        ids = Array.isArray(raw.nodeIds) ? raw.nodeIds : []
      } catch {
        /* no selection file */
      }
      const doc = readCanvas()
      const nodes = (doc.nodes || [])
        .filter((n) => ids.includes(n.id))
        .map((n) => ({
          id: n.id,
          type: n.type,
          name: n.data?.name,
          path: n.data?.path,
          prompt: n.data?.prompt,
          text: n.type === 'text' ? (n.data?.text || '').slice(0, 400) : undefined
        }))
      return toText(
        JSON.stringify(
          { count: nodes.length, nodes, note: nodes.length ? undefined : 'nothing selected on the canvas' },
          null,
          2
        )
      )
    }
  },

  canvas_outputs_group: {
    description:
      'Group all ungrouped nodes created since the last group into one labeled frame with grid layout (run ONCE per turn after producing 2+ nodes; the server decides what "this turn" means — do not list nodes first, do not pass node ids).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Group label, e.g. 品牌海报方案 or 分镜 01-06' }
      },
      additionalProperties: false
    },
    async run(args) {
      const doc = readCanvas()
      const nodes = doc.nodes || []
      const groupTimes = nodes
        .filter((n) => n.type === 'group' && n.data?.createdAt)
        .map((n) => Date.parse(n.data.createdAt))
        .filter(Number.isFinite)
      const since = groupTimes.length ? Math.max(...groupTimes) : 0
      const recent = nodes.filter((n) => {
        if (n.type === 'group' || n.parentId) return false
        const t = n.data?.createdAt ? Date.parse(n.data.createdAt) : NaN
        return Number.isFinite(t) && t > since
      })
      if (recent.length < 2) {
        return toText(
          JSON.stringify(
            { status: 'no-op', grouped: recent.length, note: 'fewer than 2 new ungrouped nodes since the last group' },
            null,
            2
          )
        )
      }
      const group = groupMembers(doc, recent, args?.label)
      writeCanvas(doc)
      return toText(
        JSON.stringify(
          { status: 'ok', group_id: group.id, label: group.data.name, grouped: recent.map((n) => ({ id: n.id, name: n.data?.name })) },
          null,
          2
        )
      )
    }
  },

  canvas_nodes_group: {
    description: 'Group specific canvas nodes (by ids) into one labeled frame with grid layout.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to group (2+)' },
        label: { type: 'string', description: 'Group label' }
      },
      required: ['node_ids']
    },
    async run(args) {
      const doc = readCanvas()
      const ids = Array.isArray(args.node_ids) ? args.node_ids : []
      if (ids.length < 2) return toError('canvas_nodes_group needs at least 2 node ids')
      const members = (doc.nodes || []).filter((n) => ids.includes(n.id) && n.type !== 'group' && !n.parentId)
      if (members.length < 2) {
        return toError('need at least 2 existing ungrouped nodes matching node_ids (already-grouped nodes are skipped)')
      }
      const group = groupMembers(doc, members, args?.label)
      writeCanvas(doc)
      return toText(JSON.stringify({ status: 'ok', group_id: group.id, grouped: members.length }, null, 2))
    }
  },

  canvas_node_ungroup: {
    description: 'Remove one node from its group (or dissolve a group node entirely when a group id is passed).',
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string', description: 'Child node id, or a group id to dissolve the whole group' } },
      required: ['node_id']
    },
    async run(args) {
      const doc = readCanvas()
      const node = (doc.nodes || []).find((n) => n.id === args.node_id)
      if (!node) return toError(`node not found: ${args.node_id}`)
      if (node.type === 'group') {
        let freed = 0
        for (const n of doc.nodes || []) {
          if (n.parentId === node.id) {
            delete n.parentId
            freed++
          }
        }
        doc.nodes = doc.nodes.filter((n) => n.id !== node.id)
        writeCanvas(doc)
        return toText(`group dissolved: ${node.id}, ${freed} nodes freed`)
      }
      if (!node.parentId) return toError(`node is not inside a group: ${args.node_id}`)
      delete node.parentId
      writeCanvas(doc)
      return toText(`node removed from group: ${node.id}`)
    }
  }
}

// ---------- deliverable plan (.entropy/plan.json + mirror text node) ----------

const PLAN_FILE = path.join(ED_DIR, 'plan.json')
const STAGE_STATUS = ['waiting', 'doing', 'done', 'blocked', 'cancelled']
const STAGE_WAITING_REASONS = ['plan_review', 'result_review']
const STATUS_ICON = { waiting: '⏳', doing: '🔄', done: '✅', blocked: '⛔', cancelled: '🚫' }

function readPlan() {
  try {
    return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function writePlan(plan) {
  fs.mkdirSync(ED_DIR, { recursive: true })
  plan.updated_at = new Date().toISOString()
  const tmp = PLAN_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), 'utf-8')
  fs.renameSync(tmp, PLAN_FILE)
}

function planActive(plan) {
  return !!plan && (plan.stages || []).some((s) => s.status !== 'done' && s.status !== 'cancelled')
}

function renderPlanMarkdown(plan) {
  const rows = (plan.stages || [])
    .map((s) => {
      const icon = STATUS_ICON[s.status] || s.status
      const reason = s.waiting_reason ? `（${s.waiting_reason}）` : ''
      const outs = s.outputs?.length ? ` → ${s.outputs.join('、')}` : ''
      return `| ${s.order} | ${s.name} | ${s.goal || ''} | ${icon} ${s.status}${reason}${outs} |`
    })
    .join('\n')
  return [
    `# 执行计划：${plan.goal}`,
    '',
    '| # | 阶段 | 目标 | 状态 |',
    '|---|------|------|------|',
    rows,
    '',
    '> ⏳ 待执行 · 🔄 进行中 · ✅ 已完成 · ⛔ 受阻 · 🚫 已取消'
  ].join('\n')
}

/** Update (or recreate) the canvas mirror text node of the plan. Sets plan.mirror_node_id. */
function syncPlanMirror(plan) {
  const doc = readCanvas()
  let node = plan.mirror_node_id ? (doc.nodes || []).find((n) => n.id === plan.mirror_node_id) : null
  if (!node) {
    node = {
      id: crypto.randomUUID(),
      type: 'text',
      positions: { main: nextNodePos(doc, 420) },
      size: { width: 420, height: 320 },
      data: { name: '执行计划', planId: plan.plan_id }
    }
    doc.nodes.push(node)
    plan.mirror_node_id = node.id
  }
  node.data = { ...node.data, name: '执行计划', planId: plan.plan_id, text: renderPlanMarkdown(plan) }
  writeCanvas(doc)
}

function findStage(plan, stageId) {
  const key = String(stageId ?? '').trim()
  return (plan.stages || []).find((s) => s.id === key || String(s.order) === key)
}

function nextAction(plan) {
  const stages = plan.stages || []
  const doing = stages.find((s) => s.status === 'doing')
  if (doing) return `continue stage ${doing.order}: ${doing.name}`
  const blocked = stages.find((s) => s.status === 'blocked')
  if (blocked) return `stage ${blocked.order} (${blocked.name}) is blocked — resolve it or replan with plan_create replace:true`
  const waiting = stages.find((s) => s.status === 'waiting')
  if (waiting) return `execute stage ${waiting.order}: ${waiting.name}${waiting.goal ? ` — ${waiting.goal}` : ''}`
  return 'all stages done — deliver the final summary with backticked filenames'
}

function planSummary(plan) {
  return {
    plan_id: plan.plan_id,
    goal: plan.goal,
    stage_count: (plan.stages || []).length,
    stages: (plan.stages || []).map((s) => ({
      id: s.id,
      order: s.order,
      name: s.name,
      goal: s.goal,
      status: s.status,
      waiting_reason: s.waiting_reason || undefined,
      outputs: s.outputs?.length ? s.outputs : undefined
    })),
    next_action: nextAction(plan)
  }
}

const planTools = {
  plan_create: {
    description:
      'Create the Deliverable Plan for a complex task (multi-shot film, series, or 2+ dependent deliverables). ' +
      'Writes .entropy/plan.json and mirrors a 执行计划 text node on the canvas. ' +
      'Rejects when an unfinished plan already exists — pass replace:true to replan (and tell the user what changed). ' +
      'After creating the plan, summarize the stages in one short message and wait for confirmation before executing stage 1.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Overall deliverable this plan produces, e.g. 15s 品牌产品广告成片' },
        stages: {
          type: 'array',
          description: 'Ordered stages (1-12), each with a concrete deliverable',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Stage name, e.g. 首帧样例 / 分镜 / 逐镜生成 / 配音 / 合成' },
              goal: { type: 'string', description: 'What this stage must produce or decide' }
            },
            required: ['name']
          }
        },
        replace: { type: 'boolean', description: 'true = discard the current unfinished plan and replace it (replan)' }
      },
      required: ['goal', 'stages']
    },
    async run(args) {
      const existing = readPlan()
      if (planActive(existing) && !args.replace) {
        const done = (existing.stages || []).filter((s) => s.status === 'done').length
        return toError(
          `an unfinished plan already exists (goal: ${existing.goal}; ${done}/${existing.stages.length} stages done). ` +
            'Continue it with plan_stage_state_update, or pass replace:true to replan — and tell the user what changed.'
        )
      }
      const raw = Array.isArray(args.stages) ? args.stages.slice(0, 12) : []
      if (raw.length === 0) return toError('plan_create requires at least one stage')
      const plan = {
        plan_id: crypto.randomUUID(),
        goal: String(args.goal || '').trim(),
        created_at: new Date().toISOString(),
        mirror_node_id: args.replace && existing ? existing.mirror_node_id : null,
        stages: raw.map((s, i) => ({
          id: `s${i + 1}`,
          order: i + 1,
          name: String(s?.name || `阶段${i + 1}`).slice(0, 60),
          goal: String(s?.goal || '').slice(0, 300),
          status: 'waiting',
          waiting_reason: null,
          note: '',
          outputs: []
        }))
      }
      if (!plan.goal) return toError('plan_create requires a goal')
      syncPlanMirror(plan)
      writePlan(plan)
      return toText(
        JSON.stringify(
          {
            status: 'ok',
            ...planSummary(plan),
            note: 'plan created and mirrored on the canvas. Briefly summarize the stages to the user and wait for confirmation (plan review) before executing stage 1 — unless the user already delegated decisions.'
          },
          null,
          2
        )
      )
    }
  },

  plan_stage_patch: {
    description: 'Append one stage to the end of the current plan (only while the plan is not finished).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stage name' },
        goal: { type: 'string', description: 'What this stage must produce or decide' }
      },
      required: ['name']
    },
    async run(args) {
      const plan = readPlan()
      if (!plan) return toError('no plan exists. Create one with plan_create first.')
      if (!planActive(plan)) return toError('the current plan is finished; replan with plan_create replace:true to add stages.')
      const order = plan.stages.length + 1
      if (order > 12) return toError('plan reached the 12-stage limit')
      plan.stages.push({
        id: `s${order}`,
        order,
        name: String(args.name || `阶段${order}`).slice(0, 60),
        goal: String(args.goal || '').slice(0, 300),
        status: 'waiting',
        waiting_reason: null,
        note: '',
        outputs: []
      })
      syncPlanMirror(plan)
      writePlan(plan)
      return toText(JSON.stringify({ status: 'ok', ...planSummary(plan) }, null, 2))
    }
  },

  plan_stage_status: {
    description:
      'Get the current Deliverable Plan summary: stage list with statuses and the next_action to take. Call this when resuming a project or unsure where the plan stands.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const plan = readPlan()
      if (!plan) {
        return toText(JSON.stringify({ status: 'no-plan', note: 'no plan in this project; use plan_create for complex tasks' }, null, 2))
      }
      return toText(JSON.stringify(planActive(plan) ? { status: 'active', ...planSummary(plan) } : { status: 'finished', ...planSummary(plan) }, null, 2))
    }
  },

  plan_stage_state_update: {
    description:
      'Update one stage of the current plan (state machine: waiting → doing → done, or blocked/cancelled). ' +
      'Call with status:"doing" when starting a stage, status:"done" with outputs (produced filenames) when it succeeds, ' +
      'status:"waiting" + waiting_reason:"result_review" when the user must review, status:"blocked" when you cannot proceed. ' +
      'expected_status is a compare-and-swap guard — pass it to fail loudly if the stage moved on meanwhile.',
    inputSchema: {
      type: 'object',
      properties: {
        stage_id: { type: 'string', description: 'Stage id (s1, s2, …) or order number' },
        status: { type: 'string', enum: STAGE_STATUS, description: 'New status' },
        expected_status: { type: 'string', enum: STAGE_STATUS, description: 'CAS guard: fail unless the stage is currently in this status' },
        waiting_reason: { type: 'string', enum: STAGE_WAITING_REASONS, description: 'Why the stage is waiting/blocked for the user' },
        note: { type: 'string', description: 'One-line progress note, e.g. the failure reason when blocked' },
        outputs: { type: 'array', items: { type: 'string' }, description: 'Filenames produced by this stage (appended, deduped)' }
      },
      required: ['stage_id', 'status']
    },
    async run(args) {
      const plan = readPlan()
      if (!plan) return toError('no plan exists. Create one with plan_create first.')
      const stage = findStage(plan, args.stage_id)
      if (!stage) {
        const list = (plan.stages || []).map((s) => `${s.id}=${s.name}`).join(', ')
        return toError(`stage not found: ${args.stage_id}. Stages: ${list}`)
      }
      if (args.expected_status && stage.status !== args.expected_status) {
        return toError(
          `stage ${stage.id} (${stage.name}) status changed: expected "${args.expected_status}" but it is currently "${stage.status}". ` +
            'Re-read with plan_stage_status before deciding.'
        )
      }
      if (!STAGE_STATUS.includes(args.status)) return toError(`invalid status: ${args.status}`)
      if (args.waiting_reason && args.status !== 'waiting' && args.status !== 'blocked') {
        return toError('waiting_reason only applies to status waiting or blocked')
      }
      stage.status = args.status
      stage.waiting_reason = args.waiting_reason || null
      if (typeof args.note === 'string') stage.note = args.note.slice(0, 200)
      if (Array.isArray(args.outputs)) {
        for (const o of args.outputs.map(String)) {
          if (o && !stage.outputs.includes(o)) stage.outputs.push(o)
        }
      }
      syncPlanMirror(plan)
      writePlan(plan)
      return toText(JSON.stringify({ status: 'ok', ...planSummary(plan) }, null, 2))
    }
  }
}

// ---------- image generation providers ----------

/**
 * DashScope native image generation (qwen-image / wan models are NOT served on
 * the OpenAI-compatible /images/generations path). Synchronous multimodal call, 30-120s.
 * With reference images it switches to the image-editing model (qwen-image-edit).
 */
async function generateDashScopeImage(args, cfg) {
  const apiKey = cfg.apiKey
  const refs = Array.isArray(args.ref_images) ? args.ref_images.filter(Boolean) : []
  const defaultModel = refs.length > 0 ? 'qwen-image-edit' : 'qwen-image-3.0-pro'
  const model = args.model || cfg.model || defaultModel
  const size = (args.size || cfg.size || '1024x1024').replace('x', '*')
  const content = []
  for (const ref of refs) {
    const buf = fs.readFileSync(ref)
    const mime = path.extname(ref).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
    content.push({ image: `data:${mime};base64,${buf.toString('base64')}` })
  }
  content.push({ text: args.prompt })
  const messages = [{ role: 'user', content }]
  const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: { messages }, parameters: { size } })
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`dashscope image ${res.status}: ${t.slice(0, 400)}`)
  }
  const data = await res.json()
  const out = data?.output?.choices?.[0]?.message?.content || []
  const url = out.find((c) => c.image)?.image
  if (!url) throw new Error(`dashscope image returned no image: ${JSON.stringify(data).slice(0, 300)}`)
  const imgRes = await fetch(url)
  if (!imgRes.ok) throw new Error(`dashscope image download ${imgRes.status}`)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  const fname = slugify(args.save_name || (refs.length > 0 ? 'qwen-image-edit' : 'qwen-image')).replace(/\.[a-z]+$/i, '.png')
  const rel = path.join('generated', fname)
  const abs = path.join(PROJECT_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
  return [rel.split(path.sep).join('/')]
}

async function generateOpenAIImage(args, cfg) {
  const model = args.model || cfg.model || 'gpt-image-1'
  const size = args.size || cfg.size || '1024x1024'
  const n = Math.min(Math.max(args.n || 1, 1), 4)
  const base = (cfg.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${cfg.apiKey}` }

  const refs = Array.isArray(args.ref_images) ? args.ref_images.filter(Boolean) : []
  let res
  if (refs.length > 0) {
    // image edits (image-to-image) via multipart
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', args.prompt)
    form.append('n', String(n))
    if (size && model !== 'gpt-image-1') form.append('size', size)
    for (const [i, ref] of refs.entries()) {
      const buf = fs.readFileSync(ref)
      form.append('image[]', new Blob([buf]), path.basename(ref) || `ref${i}.png`)
    }
    res = await fetch(`${base}/images/edits`, { method: 'POST', headers, body: form })
  } else {
    res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: args.prompt, n, size })
    })
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`image API ${res.status}: ${t.slice(0, 500)}`)
  }
  const data = await res.json()
  const items = data.data || []
  const saved = []
  for (const item of items) {
    let buf
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64')
    } else if (item.url) {
      const imgRes = await fetch(item.url)
      buf = Buffer.from(await imgRes.arrayBuffer())
    } else {
      throw new Error('image API returned no image data')
    }
    const fname = slugify(args.save_name || 'generated')
    const rel = path.join('generated', fname)
    const abs = path.join(PROJECT_DIR, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buf)
    saved.push(rel.split(path.sep).join('/'))
  }
  return saved
}

async function generateComfyImage(args, cfg) {
  // a single workflowPath FILE stays supported for image_generate; named/managed
  // workflows go through the comfy_* tools. References switch to the img2img twin.
  const refs = Array.isArray(args.ref_images) ? args.ref_images.filter(Boolean) : []
  let name = refs.length > 0 ? 'builtin-img2img' : 'builtin-txt2img'
  if (refs.length === 0 && cfg.workflowPath && fs.existsSync(cfg.workflowPath) && fs.statSync(cfg.workflowPath).isFile()) {
    name = path.basename(cfg.workflowPath, '.json')
  }
  const { saved } = await runComfyWorkflow(cfg, {
    name,
    prompt: args.prompt,
    negative_prompt: args.negative_prompt,
    size: refs.length > 0 ? undefined : args.size,
    image_path: refs[0] ? path.resolve(refs[0]) : undefined,
    count: Math.min(Math.max(args.n || 1, 1), 4),
    saveName: args.save_name || 'comfy',
    projectDir: PROJECT_DIR
  })
  return saved
}

function addImageNode(relPath, args, providerUsed) {
  const doc = readCanvas()
  const pos = nextNodePos(doc)
  const node = {
    id: crypto.randomUUID(),
    type: 'image',
    positions: { main: pos },
    data: {
      name: args.save_name || path.basename(relPath),
      path: relPath,
      prompt: args.prompt,
      provider: providerUsed,
      sourceNodeId: args.source_node_id || undefined
    }
  }
  addEdgeToDoc(doc, args.source_node_id, node.id)
  return addNode(doc, node)
}

const generationTools = {
  list_generation_providers: {
    description:
      'List configured media generation providers (image / video / audio / ffmpeg) and their status. Call before generating to pick a valid provider.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const s = loadSettings()
      const openai = s.image?.openai
      const comfy = s.image?.comfyui
      const v = s.video || {}
      const videoAvail = {}
      if (v.kling) videoAvail.kling = { available: !!(v.kling.enabled && v.kling.accessKey && v.kling.secretKey), model: v.kling.model }
      if (v.minimax) videoAvail.minimax = { available: !!(v.minimax.enabled && v.minimax.apiKey), model: v.minimax.model }
      if (v.fal) videoAvail.fal = { available: !!(v.fal.enabled && v.fal.apiKey), model: v.fal.model }
      if (v.custom) {
        videoAvail.custom = {
          available: !!(v.custom.enabled && v.custom.submitUrl && v.custom.queryUrl),
          name: v.custom.name,
          model: v.custom.model
        }
      }
      const tts = s.audio?.tts
      const music = s.audio?.music
      const bins = resolveMediaBins(loadSettings)
      return toText(
        JSON.stringify(
          {
            image: {
              openai_compatible: openai?.enabled && openai?.apiKey
                ? { available: true, model: openai.model, baseURL: openai.baseURL, size: openai.size }
                : { available: false, reason: 'not enabled or apiKey missing (configure in app settings)' },
              comfyui: comfy?.enabled
                ? { available: true, url: comfy.url, workflow: comfy.workflowPath || 'built-in txt2img' }
                : { available: false, reason: 'not enabled' }
            },
            video: videoAvail,
            video_default_provider: v.defaultProvider || '',
            audio: {
              tts: tts?.enabled && tts?.apiKey
                ? { available: true, model: tts.model, voice: tts.voice }
                : { available: false, reason: 'not enabled or apiKey missing' },
              music: music?.enabled && (music.apiKey || v.fal?.apiKey)
                ? { available: true, model: music.model }
                : { available: false, reason: 'not enabled or no apiKey (falls back to fal video key)' }
            },
            media: bins.ffmpeg
              ? { ffmpeg: { available: true, path: bins.ffmpeg } }
              : { ffmpeg: { available: false, reason: 'ffmpeg not found — install it or set 设置 → 常规 → FFmpeg 路径' } },
            vision: s.vision?.enabled && s.vision?.apiKey && s.vision?.baseURL
              ? { available: true, model: s.vision.model, note: 'media_analyse 可用（图像/视频理解）' }
              : { available: false, reason: '未配置 — 设置 → 媒体理解（OpenAI 兼容视觉端点）' }
          },
          null,
          2
        )
      )
    }
  },

  image_generate: {
    description:
      'Generate image(s) from a text prompt using a configured provider (OpenAI-compatible API or local ComfyUI). ' +
      'The result is saved into the project folder and placed on the canvas as an image node. ' +
      'Image-to-image / editing: pass ref_images (absolute paths) or ref_node_ids (canvas image nodes — paths are resolved ' +
      'and lineage is linked automatically). OpenAI-compatible providers use /images/edits (multi-reference supported); ' +
      'DashScope uses qwen-image-edit; ComfyUI uses the built-in img2img workflow (first reference, denoise 0.65). ' +
      'Identity-locked series (三视图/角色设定/系列图): set series_count (2-8) — one base image is generated first, then each ' +
      'variation is produced via image-to-image anchored on the BASE (not chained), so the subject stays consistent across the ' +
      'series; use variation_prompt to steer each variation (e.g. "same character, side view, same lighting"). ' +
      'series_count overrides n; expect 1 base + (series_count-1) variation nodes on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full image prompt. Describe subject, style, composition, lighting.' },
        provider: { type: 'string', enum: ['openai', 'comfyui'], description: 'Provider; default is first available' },
        model: { type: 'string', description: 'Model id override' },
        size: { type: 'string', description: 'e.g. 1024x1024, 1536x1024, 1024x1536' },
        n: { type: 'number', description: 'Number of images, 1-4 (independent variants; ignored when series_count>1)' },
        series_count: { type: 'number', description: 'Identity-locked series size, 2-8 (base + variations via i2i anchoring)' },
        variation_prompt: { type: 'string', description: 'Prompt applied to each variation (default: same as prompt)' },
        negative_prompt: { type: 'string', description: 'ComfyUI only' },
        ref_images: { type: 'array', items: { type: 'string' }, description: 'Reference image absolute paths' },
        ref_node_ids: { type: 'array', items: { type: 'string' }, description: 'Reference images as canvas node ids (preferred for on-canvas material; auto lineage)' },
        source_node_id: { type: 'string', description: 'Canvas node id this generation is based on (defaults to first ref node)' },
        save_name: { type: 'string', description: 'Base name for saved files' }
      },
      required: ['prompt']
    },
    async run(args) {
      const s = loadSettings()
      const openai = s.image?.openai
      const comfy = s.image?.comfyui
      let provider = args.provider
      if (!provider) {
        if (openai?.enabled && openai?.apiKey) provider = 'openai'
        else if (comfy?.enabled) provider = 'comfyui'
      }
      if (!provider) return toError('no image provider configured. Ask the user to configure one in app settings (设置).')

      // resolve canvas-node references into absolute paths; first ref becomes the lineage source
      const refs = (Array.isArray(args.ref_images) ? args.ref_images : []).filter(Boolean).map(String)
      const refNodeIds = (Array.isArray(args.ref_node_ids) ? args.ref_node_ids : []).filter(Boolean).map(String)
      if (refNodeIds.length > 0) {
        const doc = readCanvas()
        for (const nid of refNodeIds) {
          const node = (doc.nodes || []).find((n) => n.id === nid)
          if (!node) return toError(`ref node not found on canvas: ${nid} — 先用 canvas_nodes_list 确认节点 id`)
          if (!node.data?.path) return toError(`ref node ${nid} 不是图像/文件节点（没有 path）`)
          const abs = path.isAbsolute(node.data.path) ? node.data.path : path.join(PROJECT_DIR, node.data.path)
          if (!fs.existsSync(abs)) return toError(`参考图文件不存在：${node.data.path}`)
          refs.push(abs)
        }
        if (!args.source_node_id) args = { ...args, source_node_id: refNodeIds[0] }
      }
      args = { ...args, ref_images: refs }

      // one provider call → saved relative paths (provider branching lives here only)
      async function generateOnce(a) {
        if (provider === 'openai') {
          if (!openai?.apiKey) throw new Error('OpenAI-compatible provider has no apiKey configured')
          // qwen-image / wan models are not served on the OpenAI images path — route to DashScope native
          if ((openai.baseURL || '').includes('dashscope.aliyuncs.com')) return await generateDashScopeImage(a, openai)
          return await generateOpenAIImage(a, openai)
        }
        if (provider === 'comfyui') {
          if (!comfy?.enabled) throw new Error('ComfyUI provider is not enabled')
          return await generateComfyImage(a, comfy)
        }
        throw new Error(`unknown provider: ${provider}`)
      }

      const t0 = Date.now()
      const series = Math.min(Math.max(Number(args.series_count) || 1, 1), 8)
      try {
        // base image (single shot when building a series)
        const baseArgs = series > 1 ? { ...args, n: 1, series_count: undefined } : args
        const baseFiles = await generateOnce(baseArgs)
        const baseNodes = baseFiles.map((f) => addImageNode(f, baseArgs, provider))
        if (series === 1) {
          return toText(
            JSON.stringify(
              {
                status: 'ok',
                provider,
                seconds: Math.round((Date.now() - t0) / 1000),
                images: baseNodes.map((node, i) => ({ node_id: node.id, file: baseFiles[i] })),
                note: 'images are placed on the canvas; reference them in your reply with the file name in backticks'
              },
              null,
              2
            )
          )
        }

        // variations: each anchored on the base image (i2i), never chained — drift can't accumulate
        const baseNode = baseNodes[0]
        const baseAbs = path.join(PROJECT_DIR, baseFiles[0])
        const variations = []
        const vErrors = []
        for (let i = 2; i <= series; i++) {
          const vArgs = {
            ...args,
            n: 1,
            series_count: undefined,
            prompt: args.variation_prompt || args.prompt,
            ref_images: [baseAbs],
            source_node_id: baseNode.id,
            save_name: `${args.save_name || 'series'}-v${String(i).padStart(2, '0')}`
          }
          try {
            const files = await generateOnce(vArgs)
            const node = addImageNode(files[0], vArgs, provider)
            variations.push({ node_id: node.id, file: files[0] })
          } catch (e) {
            vErrors.push({ index: i, error: String(e?.message || e).slice(0, 300) })
          }
        }
        return toText(
          JSON.stringify(
            {
              status: variations.length > 0 ? 'ok' : 'partial',
              provider,
              seconds: Math.round((Date.now() - t0) / 1000),
              base: { node_id: baseNode.id, file: baseFiles[0] },
              variations,
              failed: vErrors.length ? vErrors : undefined,
              note: 'series placed on canvas: base → variations (identity anchored on base). Deliver each file in backticks; if variations failed, retry once with a changed variation_prompt (see retry-discipline contract).'
            },
            null,
            2
          )
        )
      } catch (e) {
        return toError(String(e?.message || e))
      }
    }
  },

  speech_generate: {
    description:
      'Text-to-speech using an OpenAI-compatible TTS API (/audio/speech). Saves an mp3 into the project and places an audio node on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak' },
        voice: { type: 'string', description: 'Voice id (e.g. alloy, echo; provider-dependent)' },
        model: { type: 'string', description: 'Model override (e.g. tts-1)' },
        speed: { type: 'number', description: '0.25 - 4.0' },
        source_node_id: { type: 'string', description: 'Canvas node id this generation is based on' },
        save_name: { type: 'string' }
      },
      required: ['text']
    },
    async run(args) {
      const s = loadSettings()
      const tts = s.audio?.tts
      if (!tts?.enabled || !tts?.apiKey) {
        return toError('TTS 未配置。请让用户在 设置 → 语音 · 音乐 中启用 OpenAI 兼容 TTS 并填写 API Key。')
      }
      const t0 = Date.now()
      const rel = await generateOpenAISpeech(args, tts, PROJECT_DIR)
      const doc = readCanvas()
      const pos = nextNodePos(doc)
      const node = {
        id: crypto.randomUUID(),
        type: 'audio',
        positions: { main: pos },
        data: { name: args.save_name || path.basename(rel), path: rel, text: args.text?.slice(0, 200), provider: 'openai-tts', sourceNodeId: args.source_node_id || undefined }
      }
      addEdgeToDoc(doc, args.source_node_id, node.id)
      addNode(doc, node)
      return toText(
        JSON.stringify({ status: 'ok', seconds: Math.round((Date.now() - t0) / 1000), audio: { node_id: node.id, file: rel } }, null, 2)
      )
    }
  },

  music_generate: {
    description:
      'Generate instrumental music / soundscape from a prompt via fal.ai (queue API). Saves an mp3 and places an audio node on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Music description: genre, mood, instruments, tempo' },
        duration: { type: 'number', description: 'Seconds (model-dependent)' },
        model: { type: 'string', description: 'fal model path override' },
        source_node_id: { type: 'string', description: 'Canvas node id this generation is based on' },
        save_name: { type: 'string' }
      },
      required: ['prompt']
    },
    async run(args) {
      const s = loadSettings()
      const m = s.audio?.music
      const apiKey = m?.apiKey || s.video?.fal?.apiKey
      if (!m?.enabled || !apiKey) {
        return toError(
          '音乐生成未配置。请让用户在 设置 → 语音 · 音乐 中启用（API Key 留空时自动复用 fal.ai 视频 Key）。'
        )
      }
      const t0 = Date.now()
      const rel = await generateFalMusic(args, { ...m, apiKey }, PROJECT_DIR)
      const doc = readCanvas()
      const pos = nextNodePos(doc)
      const node = {
        id: crypto.randomUUID(),
        type: 'audio',
        positions: { main: pos },
        data: { name: args.save_name || path.basename(rel), path: rel, prompt: args.prompt, provider: 'fal-music', sourceNodeId: args.source_node_id || undefined }
      }
      addEdgeToDoc(doc, args.source_node_id, node.id)
      addNode(doc, node)
      return toText(
        JSON.stringify({ status: 'ok', seconds: Math.round((Date.now() - t0) / 1000), audio: { node_id: node.id, file: rel } }, null, 2)
      )
    }
  },

  video_generate: {
    description:
      'Generate a video from a text prompt (and optional first-frame reference image for image-to-video) using a configured provider: ' +
      'kling (可灵, accessKey/secretKey), minimax (海螺 Hailuo, apiKey), fal (fal.ai, apiKey). ' +
      'The result mp4 is saved into the project folder and placed on the canvas as a video node. ' +
      'Video generation is slow (1-10 min); send one short sentence to the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full video prompt: subject, action, camera movement, lighting, style.' },
        provider: { type: 'string', enum: ['kling', 'minimax', 'fal', 'custom'], description: 'Provider; default is first enabled. custom = user-configured task-style API (URL + key)' },
        model: { type: 'string', description: 'Model id override (e.g. kling-v1-master, I2V-01, fal-ai/model/path)' },
        duration: { type: 'number', description: 'Seconds, typically 5 or 10 (forwarded by kling / minimax / fal / custom)' },
        aspect_ratio: { type: 'string', description: '16:9, 9:16, 1:1, 4:3, 3:4, 21:9. Ignored for minimax image-to-video — the first frame drives the ratio' },
        mode: { type: 'string', enum: ['std', 'pro'], description: '可灵档位 std（标准）/ pro（高画质），仅 kling 使用' },
        ref_image: { type: 'string', description: 'Absolute path or URL of first-frame image → switches to image-to-video' },
        tail_image: { type: 'string', description: 'Absolute path or URL of last-frame image (首尾帧模式). Requires ref_image; supported by kling/fal/custom' },
        negative_prompt: { type: 'string' },
        source_node_id: { type: 'string', description: 'Canvas node id this generation is based on (selection/source linking)' },
        save_name: { type: 'string', description: 'Base name for saved mp4' }
      },
      required: ['prompt']
    },
    async run(args) {
      const s = loadSettings()
      const v = s.video || {}
      const adapters = {
        kling: v.kling?.enabled && v.kling?.accessKey && v.kling?.secretKey ? generateKlingVideo : null,
        minimax: v.minimax?.enabled && v.minimax?.apiKey ? generateMiniMaxVideo : null,
        fal: v.fal?.enabled && v.fal?.apiKey ? generateFalVideo : null,
        custom: v.custom?.enabled && v.custom?.submitUrl && v.custom?.queryUrl ? generateCustomVideo : null
      }
      let provider = args.provider
      if (provider && !adapters[provider]) {
        const need =
          provider === 'kling' ? 'Access Key + Secret Key'
            : provider === 'custom' ? '提交地址 + 查询地址 + API Key'
              : 'API Key'
        const enabled = Object.keys(adapters).filter((k) => adapters[k])
        return toError(
          `provider "${provider}" 不可用：未启用或缺少 ${need}。请让用户在 设置 → 视频模型 勾选并填好后重试。` +
          `当前已启用的 provider：${enabled.join(', ') || '（无）'}。不要擅自改用其他 provider。`
        )
      }
      if (!provider) {
        // user's preferred default wins when set and enabled; otherwise first enabled
        const pref = v.defaultProvider
        provider = pref && adapters[pref] ? pref : Object.keys(adapters).find((k) => adapters[k])
      }
      if (!provider) {
        return toError(
          'no video provider configured. Ask the user to enable one in app settings (设置 → 视频模型): kling / minimax / fal / custom.'
        )
      }
      const t0 = Date.now()
      const rel = await adapters[provider](args, v[provider], PROJECT_DIR)
      const doc = readCanvas()
      const pos = nextNodePos(doc)
      const node = {
        id: crypto.randomUUID(),
        type: 'video',
        positions: { main: pos },
        data: {
          name: args.save_name || path.basename(rel),
          path: rel,
          prompt: args.prompt,
          provider,
          sourceNodeId: args.source_node_id || undefined,
          firstFrame: args.ref_image || undefined,
          lastFrame: args.tail_image || undefined
        }
      }
      addEdgeToDoc(doc, args.source_node_id, node.id)
      addNode(doc, node)
      return toText(
        JSON.stringify(
          {
            status: 'ok',
            provider,
            seconds: Math.round((Date.now() - t0) / 1000),
            video: { node_id: node.id, file: rel },
            note: 'video is placed on the canvas; reference it in your reply with the file name in backticks'
          },
          null,
          2
        )
      )
    }
  }
}

const skillTools = {
  list_skills: {
    description:
      'List available skills (prompt workflows) with name, title and description — built-in skills plus user-created ones (user wins on name clash). Load a matching skill BEFORE doing creative work it covers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const rows = scanSkills()
      const skills = []
      for (const row of rows) {
        let meta = {}
        try {
          meta = parseSkillMeta(row.file).meta
        } catch {
          continue // unreadable file — skip instead of failing the whole listing
        }
        skills.push({
          name: row.name,
          title: meta.title || row.name,
          description: meta.description || '',
          triggers: meta.triggers || '',
          source: row.source,
          ...(row.overrides ? { overrides: row.overrides } : {})
        })
      }
      return toText(JSON.stringify({ skills }, null, 2))
    }
  },

  load_skill: {
    description:
      'Load the full workflow instructions of one skill by name (from list_skills). Follow the returned instructions exactly for this task.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name, e.g. brand-poster' } },
      required: ['name']
    },
    async run(args) {
      const row = scanSkills().find((s) => s.name === args.name)
      if (!row) {
        const available = scanSkills()
          .map((s) => s.name)
          .join(', ')
        return toError(`skill not found: ${args.name}. Available: ${available}`)
      }
      // skill folders may ship references/ resources next to SKILL.md — surface them (with paths)
      let extras = []
      if (row.folder) {
        try {
          for (const f of fs.readdirSync(row.folder)) {
            if (f === 'SKILL.md') continue
            const sub = path.join(row.folder, f)
            if (fs.statSync(sub).isDirectory()) {
              for (const g of fs.readdirSync(sub)) extras.push(`${f}/${g}`)
            } else {
              extras.push(f)
            }
          }
        } catch {
          /* ignore */
        }
      }
      const { body } = parseSkillMeta(row.file)
      const header = `[skill: ${row.name} · ${row.source}${row.overrides ? ` · overrides ${row.overrides}` : ''}]`
      const note = extras.length ? `\n\n(本技能目录还附带资源文件，按需读取：${extras.join('、')})` : ''
      return toText(`${header}\n\n${body}${note}`)
    }
  }
}

// ---------- knowledge base (failure cards + vendor cards, read on demand) ----------

/** Split a query into latin words + CJK bigrams for scoring. */
function tokenizeQuery(q) {
  const tokens = new Set()
  for (const w of String(q).toLowerCase().match(/[a-z0-9_+#.-]{2,}/g) || []) tokens.add(w)
  const cjk = String(q).match(/[\u4e00-\u9fff]/g) || []
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1])
  if (cjk.length === 1) tokens.add(cjk[0])
  return [...tokens].filter(Boolean)
}

function loadKnowledgeCards() {
  const cards = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const { meta, body } = parseSkillMeta(full)
          cards.push({
            file: path.relative(KNOWLEDGE_DIR, full).split(path.sep).join('/'),
            name: meta.name || e.name.replace(/\.md$/, ''),
            title: meta.title || e.name,
            keywords: String(meta.keywords || ''),
            body
          })
        } catch {
          /* ignore unreadable card */
        }
      }
    }
  }
  walk(KNOWLEDGE_DIR)
  return cards
}

const knowledgeTools = {
  knowledge_search: {
    description:
      'Search the built-in knowledge base (integration-layer experience cards and provider parameter cards) by keywords. ' +
      'Consult it BEFORE image/video generation whenever the task involves reference images, realistic humans, ' +
      'in-image text, cross-medium style transfer, excluded content (negations), or an unfamiliar provider behavior. ' +
      'The full text of the top matches is returned — apply the card\'s rules to this task.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "参考图 角色 一致" or "kling 尾帧" or "图上 文字"' }
      },
      required: ['query']
    },
    async run(args) {
      const cards = loadKnowledgeCards()
      if (cards.length === 0) {
        return toText(JSON.stringify({ matches: [], note: `knowledge base empty at ${KNOWLEDGE_DIR}` }))
      }
      const tokens = tokenizeQuery(args.query || '')
      if (tokens.length === 0) return toError('knowledge_search needs a non-empty query')
      const scored = cards
        .map((c) => {
          const title = c.title.toLowerCase()
          const keywords = `${c.keywords} ${c.name}`.toLowerCase()
          const body = c.body.toLowerCase()
          let score = 0
          for (const t of tokens) {
            if (title.includes(t)) score += 3
            if (keywords.includes(t)) score += 2
            const hits = body.split(t).length - 1
            if (hits > 0) score += Math.min(hits, 3)
          }
          return { card: c, score }
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
      if (scored.length === 0) {
        return toText(
          JSON.stringify({ matches: [], note: `no knowledge card matched "${args.query}" — proceed with general practice` })
        )
      }
      return toText(
        JSON.stringify(
          {
            matches: scored.map((s, i) => ({
              file: s.card.file,
              name: s.card.name,
              title: s.card.title,
              score: s.score,
              full_text: i < 2 ? s.card.body : undefined
            })),
            note: 'apply the matched cards\' decision tests to this task before generating'
          },
          null,
          2
        )
      )
    }
  }
}

// ---------- ComfyUI managed workflows ----------

const comfyTools = {
  comfy_list_workflows: {
    description:
      'List local ComfyUI workflows the agent can run: the built-in txt2img template plus *.json files under the configured workflowPath (file or directory).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const cfg = loadSettings().image?.comfyui
      return toText(
        JSON.stringify(
          {
            comfyui: cfg?.enabled
              ? { enabled: true, url: cfg.url || 'http://127.0.0.1:8188' }
              : { enabled: false, reason: 'ComfyUI 未启用（设置 → 本地 ComfyUI）' },
            workflows: listWorkflows(cfg || {})
          },
          null,
          2
        )
      )
    }
  },

  comfy_get_workflow: {
    description:
      "Inspect one ComfyUI workflow before running it: every node's editable inputs with current values and allowed choices (from /object_info). Use this plus ask_user to confirm non-default parameters before comfy_run_workflow unless the user already delegated decisions.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Workflow name from comfy_list_workflows' } },
      required: ['name']
    },
    async run(args) {
      const cfg = loadSettings().image?.comfyui
      if (!cfg?.enabled) return toError('ComfyUI 未启用。请让用户在 设置 → 本地 ComfyUI 中启用。')
      let workflow
      try {
        workflow = loadWorkflow(cfg, args.name)
      } catch (e) {
        return toError(String(e?.message || e))
      }
      const url = (cfg.url || 'http://127.0.0.1:8188').replace(/\/$/, '')
      let objectInfo
      try {
        objectInfo = await fetchObjectInfo(url)
      } catch (e) {
        return toError(String(e?.message || e))
      }
      return toText(
        JSON.stringify(
          {
            name: args.name,
            nodes: describeWorkflow(workflow, objectInfo),
            note: 'confirm non-default parameters via ask_user before running, unless the user delegated decisions'
          },
          null,
          2
        )
      )
    }
  },

  comfy_run_workflow: {
    description:
      'Run a ComfyUI workflow 1-10 times (fresh seeds each run) and place every produced image on the canvas. ' +
      'Inspect parameters with comfy_get_workflow and confirm non-default values via ask_user first (unless the user delegated). ' +
      'params are keyed by node title, e.g. { "KSampler": { "steps": 30 } }.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name from comfy_list_workflows (default builtin-txt2img)' },
        prompt: { type: 'string', description: 'Convenience: injected into the node titled Prompt' },
        negative_prompt: { type: 'string', description: 'Convenience: injected into the node titled Negative Prompt' },
        size: { type: 'string', description: 'Convenience WxH, e.g. 1024x1024 (builtin Empty Latent Image only)' },
        image_path: { type: 'string', description: 'Reference image absolute path — uploaded to ComfyUI and injected into the workflow\'s LoadImage node (builtin-img2img or any workflow with LoadImage)' },
        params: { type: 'object', description: 'Node-title-keyed overrides: { "<node title>": { "<input key>": value } }', additionalProperties: true },
        count: { type: 'number', description: 'Number of runs, 1-10 (default 1)' },
        source_node_id: { type: 'string', description: 'Canvas node to link outputs to' },
        save_name: { type: 'string', description: 'Base name for saved files' }
      }
    },
    async run(args) {
      const cfg = loadSettings().image?.comfyui
      if (!cfg?.enabled) return toError('ComfyUI 未启用。请让用户在 设置 → 本地 ComfyUI 中启用。')
      const t0 = Date.now()
      try {
        const { saved, applied, unmatched } = await runComfyWorkflow(cfg, {
          name: args.name,
          prompt: args.prompt,
          negative_prompt: args.negative_prompt,
          size: args.size,
          image_path: args.image_path,
          params: args.params,
          count: args.count,
          saveName: args.save_name,
          projectDir: PROJECT_DIR
        })
        const images = saved.map((rel) => {
          const node = addImageNode(rel, { ...args, save_name: path.basename(rel) }, 'comfyui')
          return { node_id: node.id, file: rel }
        })
        return toText(
          JSON.stringify(
            {
              status: 'ok',
              seconds: Math.round((Date.now() - t0) / 1000),
              images,
              applied,
              unmatched: unmatched.length ? unmatched : undefined,
              note: 'images are on the canvas; deliver the filenames in backticks'
            },
            null,
            2
          )
        )
      } catch (e) {
        return toError(String(e?.message || e))
      }
    }
  }
}

// ---------- user interaction ----------

/**
 * POST JSON to the UI server. Uses node:http instead of fetch on purpose:
 * global fetch (undici) aborts with a HeadersTimeoutError after 5 minutes,
 * but the user may take longer than that to answer the question card.
 */
const API_TOKEN = process.env.ED_TOKEN || ''

function postJson(url, body, timeoutMs = 15 * 60 * 1000, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          // the UI server gates /api/* on this run's token (injected via opencode.json)
          ...(API_TOKEN ? { 'x-ed-token': API_TOKEN } : {})
        },
        ...opts
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch {
            reject(new Error(`bad JSON from ${url}: ${buf.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ask_user request timed out')))
    req.end(data)
  })
}

// ---- task progress reporting -------------------------------------------------
// Generation tools run for minutes; the desktop shell wants a live view beyond
// the current chat (home task queue). Fire-and-forget POST to main, which
// mirrors it into a WS broadcast. Must never block or fail the generation.
const TASK_TOOLS = { video_generate: 'video', image_generate: 'image', speech_generate: 'audio', music_generate: 'music' }
function reportTask(payload) {
  if (!SERVER_URL) return
  // agent:false — fire-and-forget telemetry must not ride the global keep-alive pool;
  // a busy reused socket can strand these POSTs for seconds behind long tool calls
  postJson(`${SERVER_URL}/api/agent/task-event`, payload, 5000, { agent: false }).catch(() => {})
}

const userTools = {
  ask_user: {
    description:
      'Ask the user structured questions rendered as clickable option cards. MUST be used instead of free-text questions whenever clarification is needed. Discipline: merge ALL pending dimensions into ONE call (never drip-feed); recommended option goes FIRST with a "（推荐）" suffix on its label; 2-6 options per question; never call this when the user already delegated the choice (授权词: 随便 / 都行 / 你看着办 / 快出). When the reply arrives, proceed with the next step immediately — do not restate or re-confirm the choices.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'All dimensions to clarify, asked together in one call (1-6 items).',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'One dimension, e.g. 画面比例' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'Concrete options (not A/B/C abstractions). First item = recommended.'
              },
              multiSelect: { type: 'boolean', description: 'Allow multiple selections (default false)' }
            },
            required: ['question', 'options']
          }
        }
      },
      required: ['questions']
    },
    async run(args) {
      if (!SERVER_URL) {
        return toError(
          'ask_user unavailable (no UI server). Fall back to plain-text numbered options in your reply and wait; never decide silently.'
        )
      }
      const questions = (Array.isArray(args.questions) ? args.questions : [])
        .map((q) => ({
          question: String(q?.question || ''),
          options: Array.isArray(q?.options) ? q.options.map(String) : [],
          multiSelect: !!q?.multiSelect
        }))
        .filter((q) => q.question && q.options.length > 0)
      if (questions.length === 0) return toError('ask_user requires at least one question with concrete options')
      try {
        const data = await postJson(`${SERVER_URL}/api/agent/question`, { questions })
        if (data.cancelled) {
          return toError(
            'user dismissed the question card. Briefly confirm the next step in text; do not generate silently.'
          )
        }
        const answers = Array.isArray(data.answers) ? data.answers : []
        const readable = questions
          .map((q, i) => `- ${q.question}: ${(answers[i] || []).join('、') || '(未作答)'}`)
          .join('\n')
        return toText(
          `user answered:\n${readable}\nThe question gate is now passed — proceed with the next step immediately, do not repeat these questions.`
        )
      } catch (e) {
        return toError(
          `ask_user failed (${String(e?.message || e)}). Fall back to plain-text numbered options (recommended first + "回数字或描述你想要的"); never decide silently.`
        )
      }
    }
  }
}

// ---------- MCP server plumbing ----------

const mediaTools = createMediaTools({
  readCanvas,
  addNode,
  addEdgeToDoc,
  nextNodePos,
  slugify,
  toText,
  toError,
  PROJECT_DIR,
  loadSettings
})

const analyseTools = createAnalyseTools({
  readCanvas,
  addNode,
  addEdgeToDoc,
  nextNodePos,
  toText,
  toError,
  PROJECT_DIR,
  loadSettings
})

// ---------- workflow playbooks (P3-1) ----------

function workflowFiles() {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    let file = null
    if (e.isFile() && e.name.endsWith('.md')) file = path.join(WORKFLOWS_DIR, e.name)
    else if (e.isDirectory()) {
      const candidate = path.join(WORKFLOWS_DIR, e.name, 'WORKFLOW.md')
      if (fs.existsSync(candidate)) file = candidate
    }
    if (!file) continue
    try {
      const { meta } = parseSkillMeta(file)
      out.push({
        name: meta.name || path.basename(file, '.md'),
        title: meta.title || path.basename(file, '.md'),
        description: meta.description || '',
        when: meta.when || '',
        file
      })
    } catch {
      /* skip unreadable workflow */
    }
  }
  return out
}

const workflowTools = {
  list_workflows: {
    description:
      'List the official workflow playbooks (multi-step finished-piece choreographies: brand TVC, music video, etc.). ' +
      'Check this BEFORE planning a finished video — a matching playbook beats improvising the five-step flow. ' +
      'Empty list is a legitimate answer: then proceed with the default discipline.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const wfs = workflowFiles()
      if (wfs.length === 0) return toText(JSON.stringify({ workflows: [], note: `no workflows at ${WORKFLOWS_DIR}` }))
      return toText(
        JSON.stringify(
          { workflows: wfs.map((w) => ({ name: w.name, title: w.title, description: w.description, when: w.when })) },
          null,
          2
        )
      )
    }
  },
  load_workflow: {
    description: 'Load the full playbook text of one workflow by name and follow its steps (adapt, never silently skip a checkpoint).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Workflow name from list_workflows' } },
      required: ['name']
    },
    async run(args) {
      const hit = workflowFiles().find((w) => w.name === args.name)
      if (!hit) return toError(`workflow not found: ${args.name}. See list_workflows for available playbooks.`)
      const raw = fs.readFileSync(hit.file, 'utf-8')
      const m = /^---\n[\s\S]*?\n---/.exec(raw)
      return toText(m ? raw.slice(m[0].length).trim() : raw)
    }
  }
}

// ---------- per-project memory (P3-3) ----------

const memoryTools = {
  remember: {
    description:
      'Persist one durable fact about THIS project across sessions: brand color/logo rules, adopted style decisions, ' +
      'user corrections ("never use X voice"), recurring constraints. Write short atomic cards (one fact each); ' +
      'they are retrieved by recall() in future sessions. Do NOT store task-transient notes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short fact title, e.g. 品牌主色 #1A73E8' },
        body: { type: 'string', description: 'The fact and why it holds (1-5 sentences)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Retrieval tags: brand / style / voice / constraint …' }
      },
      required: ['title', 'body']
    },
    async run(args) {
      const title = String(args.title || '').trim().slice(0, 80)
      const body = String(args.body || '').trim()
      if (!title || !body) return toError('remember requires a title and a body')
      const tags = (Array.isArray(args.tags) ? args.tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
      const slug = title
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'card'
      const fname = `${Date.now().toString(36)}-${slug}.md`
      fs.mkdirSync(MEMORY_DIR, { recursive: true })
      const doc = `---\ntitle: ${title}\ntags: ${tags.join(', ')}\ncreated: ${new Date().toISOString()}\n---\n\n${body}\n`
      fs.writeFileSync(path.join(MEMORY_DIR, fname), doc, 'utf-8')
      return toText(`remembered: ${fname} (tags: ${tags.join(', ') || '—'})`)
    }
  },
  recall: {
    description:
      'Search this project’s memory cards (from remember) before deciding anything style/brand/voice related in a NEW session. ' +
      'Returns the full text of the best matches — obey them like vendor cards. Empty result means no stored constraints.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords, e.g. "品牌 色" or "voice" or "logo"' } },
      required: ['query']
    },
    async run(args) {
      let entries = []
      try {
        entries = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'))
      } catch {
        return toText(JSON.stringify({ matches: [], note: 'no memory cards yet in this project' }))
      }
      const cards = []
      for (const f of entries) {
        try {
          const { meta, body } = parseSkillMeta(path.join(MEMORY_DIR, f))
          cards.push({ file: f, title: meta.title || f, tags: String(meta.tags || ''), body: body.replace(/^---\n[\s\S]*?\n---/, '').trim() })
        } catch {
          /* skip unreadable card */
        }
      }
      const tokens = tokenizeQuery(args.query || '')
      if (tokens.length === 0) return toError('recall needs a non-empty query')
      const scored = cards
        .map((c) => {
          let score = 0
          for (const t of tokens) {
            if (c.title.toLowerCase().includes(t)) score += 3
            if (c.tags.toLowerCase().includes(t)) score += 2
            const hits = c.body.toLowerCase().split(t).length - 1
            if (hits > 0) score += Math.min(hits, 3)
          }
          return { card: c, score }
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
      return toText(
        JSON.stringify(
          { matches: scored.map((s) => ({ file: s.card.file, title: s.card.title, tags: s.card.tags, body: s.card.body })) },
          null,
          2
        )
      )
    }
  }
}

const TOOLS = { ...canvasTools, ...planTools, ...skillTools, ...workflowTools, ...memoryTools, ...mediaTools, ...analyseTools, ...knowledgeTools, ...comfyTools, ...generationTools, ...userTools }

function toolDefs() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema
  }))
}

let buf = ''
/** Attach the stdio JSON-RPC loop only when run directly — importing this module (unit tests) must not hijack stdin. */
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  } catch {
    return false
  }
})()
if (isDirectRun) {
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) void handleMessage(line)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

/** Test-only surface for tools/unit tests (see tests/plan-state.test.mjs). Not used at runtime. */
export const _testHooks = { TOOLS, readPlan, readCanvas, planActive, nextAction, findStage, ED_DIR: () => ED_DIR }

async function handleMessage(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'entropy-mcp', version: '0.2.0' }
      }
    })
    return
  }
  if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: toolDefs() } })
    return
  }
  if (method === 'tools/call') {
    const tool = TOOLS[params?.name]
    if (!tool) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } })
      return
    }
    const taskKind = TASK_TOOLS[params?.name]
    const args = params?.arguments || {}
    let taskId = null
    const t0 = Date.now()
    if (taskKind) {
      taskId = crypto.randomUUID()
      reportTask({
        taskId,
        status: 'started',
        kind: taskKind,
        projectDir: PROJECT_DIR,
        model: String(args.model || args.tts_model || ''),
        prompt: String(args.prompt || args.text || '').slice(0, 160)
      })
    }
    try {
      const result = await tool.run(args)
      if (taskKind && taskId) {
        let extra = {}
        try {
          const parsed = JSON.parse(result?.content?.[0]?.text || '{}')
          extra = {
            provider: parsed.provider,
            seconds: parsed.seconds ?? Math.round((Date.now() - t0) / 1000),
            file: parsed.video?.file ?? parsed.image?.file ?? parsed.audio?.file ?? parsed.images?.[0]?.file ?? parsed.base?.file ?? undefined
          }
        } catch {
          extra = { seconds: Math.round((Date.now() - t0) / 1000) }
        }
        reportTask({ taskId, kind: taskKind, status: result?.isError ? 'failed' : 'completed', ...extra })
      }
      send({ jsonrpc: '2.0', id, result })
    } catch (e) {
      if (taskKind && taskId) reportTask({ taskId, kind: taskKind, status: 'failed', error: String(e?.message || e).slice(0, 200), seconds: Math.round((Date.now() - t0) / 1000) })
      send({ jsonrpc: '2.0', id, result: toError(String(e?.message || e)) })
    }
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

process.stderr.write(`[entropy-mcp] project=${PROJECT_DIR}\n`)
