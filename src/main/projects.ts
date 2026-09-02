import { shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { CanvasDocument, ExecutionPlan, ProjectInfo } from '../shared/types'
import { loadSettings } from './settings'

const CANVAS_DIR = '.entropy'

function emptyCanvas(): CanvasDocument {
  return { version: 1, mode: 'workflow', nodes: [], edges: [] }
}

export function workspaceRoot(): string {
  return loadSettings().workspaceRoot
}

export function listProjects(): ProjectInfo[] {
  const root = workspaceRoot()
  if (!fs.existsSync(root)) return []
  const out: ProjectInfo[] = []
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue // vanished between readdir and stat
    }
    const metaFile = path.join(dir, CANVAS_DIR, 'project.json')
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      out.push({
        id: meta.id,
        name: meta.name ?? name,
        path: dir,
        createdAt: meta.createdAt ?? fs.statSync(dir).birthtime.toISOString(),
        group: meta.group ?? null,
        pinned: !!meta.pinned
      })
    } catch {
      // folder without .entropy metadata is not registered as a project; allow import via openProject
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function createProject(name?: string): ProjectInfo {
  const root = workspaceRoot()
  fs.mkdirSync(root, { recursive: true })
  const base = (name || '新画布').replace(/[\\/:*?"<>|]/g, '_').trim() || '新画布'
  let dir = path.join(root, base)
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base}-${i}`)
  fs.mkdirSync(dir, { recursive: true })
  const info: ProjectInfo = {
    id: crypto.randomUUID(),
    name: path.basename(dir),
    path: dir,
    createdAt: new Date().toISOString()
  }
  writeProjectMeta(info)
  writeCanvas(dir, emptyCanvas())
  return info
}

export function openProject(dir: string): ProjectInfo {
  const resolved = path.resolve(dir)
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${resolved}`)
  const metaFile = path.join(resolved, CANVAS_DIR, 'project.json')
  let meta: ProjectInfo | null = null
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
  } catch {
    meta = null
  }
  const info: ProjectInfo =
    meta && meta.id
      ? { ...meta, path: resolved }
      : {
          id: crypto.randomUUID(),
          name: path.basename(resolved),
          path: resolved,
          createdAt: new Date().toISOString()
        }
  writeProjectMeta(info)
  if (!fs.existsSync(path.join(resolved, CANVAS_DIR, 'canvas.json'))) writeCanvas(resolved, emptyCanvas())
  return info
}

/** Rename a project folder (and its metadata). Fails if the target name is taken. */
export async function renameProject(dir: string, newName: string): Promise<ProjectInfo> {
  const resolved = path.resolve(dir)
  const metaFile = path.join(resolved, CANVAS_DIR, 'project.json')
  if (!fs.existsSync(metaFile)) throw new Error('不是有效的 Entropy Design 项目')
  const clean = (newName || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!clean) throw new Error('名称不能为空')
  const dest = path.join(path.dirname(resolved), clean)
  if (path.resolve(dest) === resolved) {
    // same name — just refresh metadata
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as ProjectInfo
    const info = { ...meta, name: clean, path: resolved }
    writeProjectMeta(info)
    return info
  }
  if (fs.existsSync(dest)) throw new Error(`同名文件夹已存在：${clean}`)
  // Windows: a just-stopped agent/opencode may still hold handles briefly — retry with backoff
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(resolved, dest)
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (lastErr) {
    throw new Error(`重命名失败（文件夹可能被占用）: ${String((lastErr as Error).message || lastErr)}`)
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dest, CANVAS_DIR, 'project.json'), 'utf-8')) as ProjectInfo
  const info = { ...meta, name: clean, path: dest }
  writeProjectMeta(info)
  return info
}

/** Move a project folder to the OS trash (recoverable). Only registered project dirs allowed. */
export async function deleteProject(dir: string): Promise<void> {
  const resolved = path.resolve(dir)
  const metaFile = path.join(resolved, CANVAS_DIR, 'project.json')
  if (!fs.existsSync(metaFile)) throw new Error('不是有效的 Entropy Design 项目')
  await shell.trashItem(resolved)
}

function updateMeta(dir: string, patch: Partial<ProjectInfo>): ProjectInfo {
  const resolved = path.resolve(dir)
  const metaFile = path.join(resolved, CANVAS_DIR, 'project.json')
  if (!fs.existsSync(metaFile)) throw new Error('不是有效的 Entropy Design 项目')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as ProjectInfo
  const info = { ...meta, ...patch, path: resolved }
  writeProjectMeta(info)
  return info
}

/** Assign a project to a group (metadata only — folders stay flat). */
export function setProjectGroup(dir: string, group: string | null): ProjectInfo {
  return updateMeta(dir, { group: group ? group.trim() || null : null })
}

export function setProjectPinned(dir: string, pinned: boolean): ProjectInfo {
  return updateMeta(dir, { pinned })
}

export function renameGroup(from: string, to: string): number {
  const clean = (to || '').replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!clean) throw new Error('分组名不能为空')
  let n = 0
  for (const p of listProjects()) {
    if (p.group === from) {
      updateMeta(p.path, { group: clean })
      n++
    }
  }
  return n
}

export function removeGroup(name: string): number {
  let n = 0
  for (const p of listProjects()) {
    if (p.group === name) {
      updateMeta(p.path, { group: null })
      n++
    }
  }
  return n
}

export interface BatchDeleteResult {
  deleted: string[]
  failed: { path: string; error: string }[]
}

export async function deleteProjectsBatch(paths: string[]): Promise<BatchDeleteResult> {
  const result: BatchDeleteResult = { deleted: [], failed: [] }
  for (const p of paths) {
    try {
      await deleteProject(p)
      result.deleted.push(p)
    } catch (e) {
      result.failed.push({ path: p, error: String((e as Error).message || e) })
    }
  }
  return result
}

function writeProjectMeta(info: ProjectInfo): void {
  const dir = path.join(info.path, CANVAS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(info, null, 2), 'utf-8')
}

export function readCanvas(projectDir: string): CanvasDocument {
  const file = path.join(projectDir, CANVAS_DIR, 'canvas.json')
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CanvasDocument> | null
    if (!doc || typeof doc !== 'object') return emptyCanvas()
    return {
      ...doc,
      version: doc.version ?? 1,
      mode: doc.mode ?? 'workflow',
      nodes: Array.isArray(doc.nodes) ? doc.nodes : [],
      edges: Array.isArray(doc.edges) ? doc.edges : []
    }
  } catch {
    return emptyCanvas()
  }
}

export function writeCanvas(projectDir: string, doc: CanvasDocument): void {
  const dir = path.join(projectDir, CANVAS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'canvas.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

/** Watch the project's .entropy dir for canvas.json / plan.json changes; returns a stop function. */
export function watchCanvas(projectDir: string, onChange: (file: 'canvas.json' | 'plan.json') => void): () => void {
  const dir = path.join(projectDir, CANVAS_DIR)
  let timer: NodeJS.Timeout | null = null
  const pending = new Set<'canvas.json' | 'plan.json'>()
  let watcher: fs.FSWatcher | null = null
  const start = (): void => {
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        // null filename (some Windows renames) is treated as a canvas change
        const file = filename === 'plan.json' ? 'plan.json' : 'canvas.json'
        if (filename && filename !== 'canvas.json' && filename !== 'plan.json') return
        // both files may be written in one burst (e.g. plan mirror updates canvas then plan):
        // collect every distinct file and fire all callbacks after the debounce window
        if (pending.has(file)) return
        pending.add(file)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const files = [...pending]
          pending.clear()
          for (const f of files) onChange(f)
        }, 150)
      })
    } catch {
      // directory may not exist yet
    }
  }
  start()
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}

// ---------- deliverable plan (written by the MCP plan tools, read by the UI) ----------

export type { ExecutionPlan, PlanStage } from '../shared/types'

export function readPlan(projectDir: string): ExecutionPlan | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(path.resolve(projectDir), CANVAS_DIR, 'plan.json'), 'utf-8')
    ) as ExecutionPlan
  } catch {
    return null
  }
}

// ---------- selection (written by renderer, read by the MCP ask/selection tools) ----------

export function writeSelection(projectDir: string, nodeIds: string[]): void {
  const dir = path.join(path.resolve(projectDir), CANVAS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'selection.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ nodeIds, updatedAt: Date.now() }), 'utf-8')
  fs.renameSync(tmp, file)
}

export function readSelection(projectDir: string): string[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(path.resolve(projectDir), CANVAS_DIR, 'selection.json'), 'utf-8')
    ) as { nodeIds?: unknown }
    return Array.isArray(raw.nodeIds) ? raw.nodeIds.map(String) : []
  } catch {
    return []
  }
}

// ---------- media import (drag-drop / API) ----------

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac'])

function mediaTypeFor(ext: string): 'image' | 'video' | 'audio' | 'file' {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'file'
}

function slugifyName(name: string): { base: string; ext: string } {
  const ext = path.extname(name || '').toLowerCase()
  const base = (path.basename(name || '', path.extname(name || '')) || 'file')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .slice(0, 60)
  return { base: base || 'file', ext: ext || '.bin' }
}

/** Copy an external media file into <project>/assets and place a card on the canvas. */
export function importFile(projectDir: string, fileName: string, buf: Buffer): { nodeId: string; file: string; type: string } {
  const resolved = path.resolve(projectDir)
  if (!fs.existsSync(path.join(resolved, CANVAS_DIR, 'project.json'))) {
    throw new Error('不是有效的 Entropy Design 项目')
  }
  const { base, ext } = slugifyName(fileName)
  const assetsDir = path.join(resolved, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  let rel = path.join('assets', `${base}${ext}`).split(path.sep).join('/')
  let abs = path.join(resolved, rel)
  let n = 1
  while (fs.existsSync(abs)) {
    rel = path.join('assets', `${base}-${n}${ext}`).split(path.sep).join('/')
    abs = path.join(resolved, rel)
    n++
  }
  fs.writeFileSync(abs, buf)

  const type = mediaTypeFor(ext)
  const doc = readCanvas(resolved)
  let maxX = 0
  let maxY = 0
  for (const node of doc.nodes || []) {
    const x = node.positions?.main?.x ?? 0
    const y = node.positions?.main?.y ?? 0
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const node = {
    id: crypto.randomUUID(),
    type,
    positions: { main: { x: doc.nodes?.length ? maxX + 40 : 0, y: maxY } },
    data: { createdAt: new Date().toISOString(), name: fileName, path: rel }
  }
  doc.nodes = doc.nodes || []
  doc.nodes.push(node)
  writeCanvas(resolved, doc)
  return { nodeId: node.id, file: rel, type }
}
