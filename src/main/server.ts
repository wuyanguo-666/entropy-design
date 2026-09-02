import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { app, dialog, BrowserWindow, shell } from 'electron'
import type { CanvasDocument, Settings } from '../shared/types'
import { listProjects, createProject, openProject, readCanvas, writeCanvas, watchCanvas, readPlan, workspaceRoot, renameProject, deleteProject, setProjectGroup, setProjectPinned, renameGroup, removeGroup, deleteProjectsBatch, writeSelection, importFile } from './projects'
import { loadSettings, saveSettings } from './settings'
import { startAgent, stopAgent, agentStatus, sendPrompt, abortPrompt, getHistory, setEventHandler, skillsDir, userSkillsDir, setServerPort, setServerToken, type AgentEvent } from './agent'
import { askUser, answerQuestion, cancelAllQuestions, type AskUserQuestion } from './questions'
import { applyTaskEvent, interruptRunningTasks, listTasks, initTasks, type TaskEventPayload } from './tasks'
import { log, openLogsFolder } from './log'
import { checkForUpdatesNow } from './updater'

interface ClientSocket extends WebSocket {
  isAlive?: boolean
}

let wss: WebSocketServer | null = null
let stopWatch: (() => void) | null = null
let watchedDir: string | null = null
let apiToken = ''

/**
 * The API serves provider keys, chat transcripts and project files, so every
 * caller must present this run's one-time token (set by index.ts, handed to the
 * renderer via preload and to the MCP child via ED_TOKEN). /api/health stays open
 * as a bind probe. Browsers can't set headers on <img>/<video>/WebSocket, so
 * /files and /ws accept the token as a query parameter.
 */
function tokenOk(req: http.IncomingMessage, url: URL): boolean {
  if (!apiToken) return true // token not configured (dev fallback)
  return req.headers['x-ed-token'] === apiToken || url.searchParams.get('token') === apiToken
}

function broadcast(msg: unknown): void {
  if (!wss) return
  const data = JSON.stringify(msg)
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data)
  }
}

export function initAgentEvents(): void {
  setEventHandler((e: AgentEvent) => {
    if (e.type === 'entropy.agent.stopped') {
      cancelAllQuestions()
      // a killed agent takes its in-flight generation tools with it — close their tasks honestly
      for (const t of interruptRunningTasks()) broadcast({ kind: 'agent-task', task: t })
    }
    broadcast({ kind: 'agent-event', event: e })
  })
}

/**
 * This API serves provider API keys and chat transcripts, so it must not be
 * readable from an arbitrary webpage on the same machine. Requests without an
 * Origin header are non-browser callers (the MCP server, curl, smoke tests).
 */
function allowedOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin
  if (!origin) return null
  if (origin === 'file://' || origin === 'null') return origin
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      if (new URL(devUrl).origin === origin) return origin
    } catch {
      /* ignore malformed dev url */
    }
  }
  const host = String(req.headers.host || '')
  if (host && (origin === `http://${host}` || origin === `http://localhost:${host.split(':')[1]}`)) return origin
  return null
}

/**
 * Project directories the renderer may address. Every path the UI uses came back
 * from createProject / openProject / listProjects, so anything else is an injection
 * attempt against endpoints that write `<dir>/.entropy/canvas.json`.
 */
const knownProjects = new Set<string>()

function rememberProjectDir(dir: string): string {
  const resolved = path.resolve(dir)
  knownProjects.add(resolved)
  return resolved
}

function insideWorkspace(resolved: string): boolean {
  const root = path.resolve(workspaceRoot())
  const rel = path.relative(root, resolved)
  // separator-aware: a bare startsWith() would let sibling dirs sharing the
  // root's prefix (e.g. "...Projects-evil") through
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** True when a file lives under one of the registered project dirs (imports can sit outside the workspace root). */
function insideAnyProject(resolved: string): boolean {
  for (const dir of knownProjects) {
    const rel = path.relative(dir, resolved)
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  }
  return false
}

/** Resolve a requested project dir, or write 403 and return null. */
function projectDir(res: http.ServerResponse, dir: string): string | null {
  if (!dir) {
    res.writeHead(400)
    res.end('path required')
    return null
  }
  const resolved = path.resolve(dir)
  if (knownProjects.has(resolved) || insideWorkspace(resolved)) return resolved
  res.writeHead(403)
  res.end('forbidden: unknown project path')
  return null
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

function serveProjectFile(res: http.ServerResponse, filePath: string): void {
  const resolved = path.resolve(filePath)
  if (!knownProjects.has(resolved) && !insideWorkspace(resolved) && !insideAnyProject(resolved)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const type =
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.json': 'application/json',
      '.md': 'text/markdown'
    }[path.extname(resolved).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type })
  fs.createReadStream(resolved).pipe(res)
}

function ensureWatch(dir: string): void {
  if (watchedDir === dir) return
  stopWatch?.()
  watchedDir = dir
  stopWatch = watchCanvas(dir, (file) => {
    if (file === 'plan.json') {
      broadcast({ kind: 'plan-changed', path: dir, plan: readPlan(dir) })
      return
    }
    broadcast({ kind: 'canvas-changed', path: dir, canvas: readCanvas(dir) })
  })
}

// ---------- skills（用户技能归档在 userData/skills，内置技能只读展示） ----------

interface SkillMeta {
  name: string
  title: string
  description: string
  triggers: string
}

interface SkillEntry extends SkillMeta {
  source: 'user' | 'builtin'
  /** 用户技能与内置技能同名时标记（用户版生效） */
  overrides?: 'builtin'
  path: string
  editable: boolean
  folder: string | null
}

function parseSkillFrontmatter(file: string): SkillMeta & { body: string } {
  const raw = fs.readFileSync(file, 'utf-8')
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  const meta: Record<string, string> = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())
      if (kv) meta[kv[1]] = kv[2].trim()
    }
  }
  return {
    name: meta.name || '',
    title: meta.title || '',
    description: meta.description || '',
    triggers: meta.triggers || '',
    body: (m ? raw.slice(m[0].length) : raw).trim()
  }
}

/** 扫描技能目录，兼容 <name>.md 平铺与 <name>/SKILL.md 技能文件夹两种布局。 */
function skillEntriesInDir(dir: string, source: 'user' | 'builtin'): SkillEntry[] {
  const out: SkillEntry[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    let file: string | null = null
    let folder: string | null = null
    if (e.isFile() && e.name.endsWith('.md')) {
      file = path.join(dir, e.name)
    } else if (e.isDirectory()) {
      const candidate = path.join(dir, e.name, 'SKILL.md')
      if (fs.existsSync(candidate)) {
        file = candidate
        folder = path.join(dir, e.name)
      }
    }
    if (!file) continue
    try {
      const parsed = parseSkillFrontmatter(file)
      out.push({
        name: parsed.name || (folder ? path.basename(folder) : path.basename(file, '.md')),
        title: parsed.title || (folder ? path.basename(folder) : path.basename(file, '.md')),
        description: parsed.description,
        triggers: parsed.triggers,
        source,
        path: file,
        editable: source === 'user',
        folder
      })
    } catch {
      /* unreadable — skip */
    }
  }
  return out
}

function listAllSkills(): SkillEntry[] {
  const byName = new Map<string, SkillEntry>()
  for (const entry of skillEntriesInDir(skillsDir(), 'builtin')) byName.set(entry.name, entry)
  fs.mkdirSync(userSkillsDir(), { recursive: true })
  for (const entry of skillEntriesInDir(userSkillsDir(), 'user')) {
    const prev = byName.get(entry.name)
    byName.set(entry.name, prev?.source === 'builtin' ? { ...entry, overrides: 'builtin' } : entry)
  }
  return [...byName.values()]
}

function renderSkillFile(fields: SkillMeta, body: string): string {
  const esc = (v: string) => v.trim()
  return `---\nname: ${esc(fields.name)}\ntitle: ${esc(fields.title) || fields.name}\ndescription: ${esc(fields.description)}\ntriggers: ${esc(fields.triggers)}\n---\n\n${body.trim()}\n`
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function userSkillFolder(name: string): string {
  return path.join(userSkillsDir(), name)
}

export function startServer(port = 8765, token = ''): Promise<number> {
  apiToken = token
  setServerPort(port)
  setServerToken(token)
  initAgentEvents()
  const recovered = initTasks()
  if (recovered) log('info', 'tasks', `restored task history, ${recovered} interrupted by restart`)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    const p = url.pathname
    const origin = allowedOrigin(req)
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'content-type, x-ed-token')
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      if (!origin && req.headers.origin) {
        res.writeHead(403)
        res.end('forbidden origin')
        return
      }
      res.writeHead(204)
      res.end()
      return
    }
    if (req.headers.origin && !origin) {
      log('warn', 'auth', `403 forbidden origin "${String(req.headers.origin)}" for ${p}`)
      res.writeHead(403)
      res.end('forbidden origin')
      return
    }
    if (p !== '/api/health' && !tokenOk(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized: missing or bad x-ed-token' }))
      return
    }
    try {
      if (p === '/api/health') return json(res, 200, { ok: true })

      if (p === '/api/log' && req.method === 'POST') {
        // renderer error forwarding (window.onerror / unhandledrejection)
        const body = JSON.parse((await readBody(req)) || '{}') as { level?: string; scope?: string; msg?: string }
        const level = body.level === 'error' || body.level === 'warn' ? body.level : 'info'
        log(level, `renderer:${String(body.scope || 'app')}`, String(body.msg || ''))
        return json(res, 200, { ok: true })
      }
      if (p === '/api/logs/open-folder' && req.method === 'POST') {
        const err = await openLogsFolder()
        return json(res, 200, { ok: !err, error: err || undefined })
      }
      if (p === '/api/updater/check' && req.method === 'POST') {
        return json(res, 200, await checkForUpdatesNow())
      }

      if (p === '/api/projects' && req.method === 'GET') return json(res, 200, listProjects())
      if (p === '/api/projects' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const info = createProject(body.name)
        rememberProjectDir(info.path)
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, info)
      }
      if (p === '/api/projects/open' && req.method === 'POST') {
        const win = BrowserWindow.getAllWindows()[0]
        const picked = await dialog.showOpenDialog(win, {
          properties: ['openDirectory'],
          defaultPath: workspaceRoot()
        })
        if (picked.canceled || !picked.filePaths[0]) return json(res, 200, null)
        const info = openProject(picked.filePaths[0])
        rememberProjectDir(info.path)
        return json(res, 200, info)
      }
      if (p === '/api/projects/rename' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const resolved = path.resolve(String(body.path || ''))
        const st = agentStatus()
        if (st.projectDir && path.resolve(st.projectDir) === resolved) await stopAgent()
        if (watchedDir === resolved) {
          stopWatch?.()
          watchedDir = null
        }
        const info = await renameProject(body.path, String(body.name || ''))
        rememberProjectDir(info.path)
        if (st.projectDir && path.resolve(st.projectDir) === resolved) {
          // the current project was renamed: keep watching and restart the agent on the new path
          ensureWatch(info.path)
          const restarted = await startAgent(info.path)
          broadcast({ kind: 'projects-changed' })
          return json(res, 200, { ...info, agent: restarted })
        }
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, info)
      }
      if (p === '/api/projects/delete' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const resolved = projectDir(res, String(body.path || ''))
        if (!resolved) return
        const st = agentStatus()
        if (st.projectDir && path.resolve(st.projectDir) === resolved) await stopAgent()
        if (watchedDir === resolved) {
          stopWatch?.()
          watchedDir = null
        }
        await deleteProject(resolved)
        knownProjects.delete(resolved)
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, { ok: true })
      }
      if (p === '/api/projects/delete-batch' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const paths: string[] = Array.isArray(body.paths) ? body.paths : []
        const allowed = paths
          .map((x) => path.resolve(String(x)))
          .filter((x) => knownProjects.has(x) || insideWorkspace(x))
        const refused = paths.length - allowed.length
        const resolvedSet = new Set(allowed)
        const st = agentStatus()
        if (st.projectDir && resolvedSet.has(path.resolve(st.projectDir))) {
          await stopAgent()
          if (watchedDir && resolvedSet.has(path.resolve(watchedDir))) {
            stopWatch?.()
            watchedDir = null
          }
        }
        const result = await deleteProjectsBatch(allowed)
        for (const x of allowed) knownProjects.delete(x)
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, refused ? { ...result, refused } : result)
      }
      if (p === '/api/projects/group' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const dir = projectDir(res, String(body.path || ''))
        if (!dir) return
        const info = setProjectGroup(dir, body.group ?? null)
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, info)
      }
      if (p === '/api/projects/pin' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const dir = projectDir(res, String(body.path || ''))
        if (!dir) return
        const info = setProjectPinned(dir, !!body.pinned)
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, info)
      }
      if (p === '/api/projects/group-rename' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const n = renameGroup(String(body.from || ''), String(body.to || ''))
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, { updated: n })
      }
      if (p === '/api/projects/group-remove' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const n = removeGroup(String(body.name || ''))
        broadcast({ kind: 'projects-changed' })
        return json(res, 200, { updated: n })
      }

      if (p === '/api/llm/fetch-models' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const base = String(body.baseURL || '').replace(/\/$/, '')
        if (!base) return json(res, 400, { error: 'baseURL required' })
        try {
          const r = await fetch(`${base}/models`, {
            headers: body.apiKey ? { authorization: `Bearer ${String(body.apiKey)}` } : {},
            signal: AbortSignal.timeout(15000)
          })
          if (!r.ok) return json(res, 200, { error: `HTTP ${r.status}` })
          const j = (await r.json()) as { data?: { id?: string }[]; models?: { id?: string }[] }
          const list = j.data || j.models || []
          const ids = list.map((m) => m?.id).filter((x): x is string => !!x)
          return json(res, 200, { models: ids })
        } catch (e) {
          return json(res, 200, { error: String((e as Error).message || e) })
        }
      }

      if (p === '/api/canvas' && req.method === 'GET') {
        const dir = projectDir(res, url.searchParams.get('path') || '')
        if (!dir) return
        return json(res, 200, readCanvas(dir))
      }
      if (p === '/api/plan' && req.method === 'GET') {
        const dir = projectDir(res, url.searchParams.get('path') || '')
        if (!dir) return
        return json(res, 200, readPlan(dir))
      }
      if (p === '/api/canvas' && req.method === 'PUT') {
        const dir = projectDir(res, url.searchParams.get('path') || '')
        if (!dir) return
        const doc = JSON.parse(await readBody(req)) as CanvasDocument
        writeCanvas(dir, doc)
        ensureWatch(dir)
        broadcast({ kind: 'canvas-changed', path: dir, canvas: doc })
        return json(res, 200, { ok: true })
      }
      if (p === '/api/canvas/selection' && req.method === 'PUT') {
        const dir = projectDir(res, url.searchParams.get('path') || '')
        if (!dir) return
        const body = JSON.parse((await readBody(req)) || '{}') as { nodeIds?: unknown }
        const ids = Array.isArray(body.nodeIds) ? body.nodeIds.map(String) : []
        writeSelection(dir, ids)
        return json(res, 200, { ok: true })
      }
      if (p === '/api/canvas/import' && req.method === 'POST') {
        // raw binary body; file name in the query (drag-drop / external media import)
        const dir = projectDir(res, url.searchParams.get('path') || '')
        if (!dir) return
        const fileName = url.searchParams.get('name') || `import-${Date.now()}`
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        try {
          const info = importFile(dir, fileName, Buffer.concat(chunks))
          ensureWatch(dir)
          broadcast({ kind: 'canvas-changed', path: dir, canvas: readCanvas(dir) })
          return json(res, 200, info)
        } catch (e) {
          return json(res, 400, { error: String((e as Error).message || e) })
        }
      }

      if (p === '/api/settings' && req.method === 'GET') return json(res, 200, loadSettings())
      if (p === '/api/settings' && req.method === 'PUT') {
        const patch = JSON.parse(await readBody(req)) as Partial<Settings>
        const prev = loadSettings()
        const next = saveSettings(patch)
        broadcast({ kind: 'settings-changed' })
        // MCP 配置与 LLM provider 列表都在 opencode 启动时注入 opencode.json —
        // 变更后自动重启当前 agent 使其生效；仅切换 activeModel 不需要重启
        const providersChanged =
          JSON.stringify(prev.llm?.providers ?? []) !== JSON.stringify(next.llm?.providers ?? [])
        if (patch.mcp || providersChanged) {
          const st = agentStatus()
          if (st.projectDir) {
            await stopAgent()
            const restarted = await startAgent(st.projectDir)
            return json(res, 200, { ...next, agent: restarted })
          }
        }
        return json(res, 200, next)
      }

      if (p === '/api/agent/start' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const dir = projectDir(res, String(body.path || ''))
        if (!dir) return json(res, 403, { error: 'unknown project path' })
        ensureWatch(dir)
        const status = await startAgent(dir)
        return json(res, 200, status)
      }
      if (p === '/api/agent/stop' && req.method === 'POST') {
        cancelAllQuestions()
        await stopAgent()
        return json(res, 200, agentStatus())
      }
      if (p === '/api/agent/status' && req.method === 'GET') return json(res, 200, agentStatus())
      if (p === '/api/agent/history' && req.method === 'GET') return json(res, 200, await getHistory())
      if (p === '/api/agent/send' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        await sendPrompt(String(body.text || ''))
        return json(res, 200, { ok: true })
      }
      if (p === '/api/agent/abort' && req.method === 'POST') {
        cancelAllQuestions()
        await abortPrompt()
        return json(res, 200, { ok: true })
      }

      if (p === '/api/agent/question' && req.method === 'POST') {
        // called by the MCP ask_user tool (long-polls until the renderer answers)
        const body = JSON.parse(await readBody(req)) as { questions?: AskUserQuestion[] }
        const questions = (Array.isArray(body.questions) ? body.questions : [])
          .map((q) => ({
            question: String(q?.question || ''),
            options: Array.isArray(q?.options) ? q.options.map(String) : [],
            multiSelect: !!q?.multiSelect
          }))
          .filter((q) => q.question && q.options.length > 0)
        if (questions.length === 0) return json(res, 400, { error: 'questions with options required' })
        const result = await askUser(questions, (entry) => {
          broadcast({ kind: 'agent-question', id: entry.id, questions: entry.questions })
        })
        return json(res, 200, result)
      }
      if (p === '/api/agent/task-event' && req.method === 'POST') {
        // fire-and-forget task mirror from MCP generation tools (never long-polls)
        const body = JSON.parse((await readBody(req)) || '{}') as TaskEventPayload
        const task = applyTaskEvent(body)
        if (!task) return json(res, 400, { error: 'taskId + status (+ kind/projectDir on start) required' })
        broadcast({ kind: 'agent-task', task })
        return json(res, 200, { ok: true })
      }
      if (p === '/api/tasks' && req.method === 'GET') return json(res, 200, listTasks())
      if (p === '/api/agent/question/answer' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { id?: string; answers?: string[][]; cancelled?: boolean }
        const ok = answerQuestion(String(body.id || ''), Array.isArray(body.answers) ? body.answers.map((a) => (Array.isArray(a) ? a.map(String) : [])) : [], !!body.cancelled)
        if (!ok) return json(res, 404, { error: 'question not found or expired' })
        return json(res, 200, { ok: true })
      }

      if (p === '/api/debug/screenshot' && req.method === 'GET' && !app.isPackaged) {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return json(res, 500, { error: 'no window' })
        const image = await win.webContents.capturePage()
        const png = image.toPNG()
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(png)
        return
      }

      if (p === '/api/skills' && req.method === 'GET') {
        return json(res, 200, listAllSkills())
      }
      if (p === '/api/skills/detail' && req.method === 'GET') {
        const name = url.searchParams.get('name') || ''
        const entry = listAllSkills().find((s) => s.name === name)
        if (!entry) return json(res, 404, { error: `技能 ${name} 不存在` })
        try {
          const parsed = parseSkillFrontmatter(entry.path)
          return json(res, 200, { ...entry, body: parsed.body })
        } catch (e) {
          return json(res, 500, { error: String((e as Error).message || e) })
        }
      }
      if (p === '/api/skills/open-folder' && req.method === 'POST') {
        fs.mkdirSync(userSkillsDir(), { recursive: true })
        const err = await shell.openPath(userSkillsDir())
        return json(res, 200, { ok: !err, error: err || undefined })
      }
      if (p === '/api/skills' && req.method === 'POST') {
        // 新建用户技能：<userSkills>/<name>/SKILL.md（技能文件夹惯例）
        const body = JSON.parse(await readBody(req)) as SkillMeta & { body?: string }
        const name = String(body.name || '').trim()
        if (!SKILL_NAME_RE.test(name)) {
          return json(res, 400, { error: '技能标识只能用小写字母/数字/中划线，且以字母或数字开头' })
        }
        const folder = userSkillFolder(name)
        if (fs.existsSync(folder)) return json(res, 409, { error: `技能 ${name} 已存在` })
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(
          path.join(folder, 'SKILL.md'),
          renderSkillFile({ name, title: body.title, description: body.description, triggers: body.triggers }, body.body || ''),
          'utf-8'
        )
        broadcast({ kind: 'skills-changed' })
        return json(res, 200, { ok: true, path: path.join(folder, 'SKILL.md') })
      }
      if (p === '/api/skills' && req.method === 'PUT') {
        // 编辑用户技能（支持改名：新名 = 新文件夹，旧目录一并迁移）
        const body = JSON.parse(await readBody(req)) as SkillMeta & { body?: string; nextName?: string }
        const name = String(body.name || '').trim()
        if (!SKILL_NAME_RE.test(name)) {
          return json(res, 400, { error: '技能标识只能用小写字母/数字/中划线，且以字母或数字开头' })
        }
        const existing = listAllSkills().find((s) => s.name === name)
        if (!existing) return json(res, 404, { error: `技能 ${name} 不存在` })
        if (!existing.editable) return json(res, 403, { error: '内置技能不可编辑；可新建一个同名用户技能来覆盖它' })
        const nextName = String(body.nextName || name).trim()
        if (!SKILL_NAME_RE.test(nextName)) {
          return json(res, 400, { error: '新技能标识只能用小写字母/数字/中划线' })
        }
        if (nextName !== name && listAllSkills().some((s) => s.name === nextName && s.source === 'user')) {
          return json(res, 409, { error: `技能 ${nextName} 已存在` })
        }
        const targetFolder = userSkillFolder(nextName)
        if (existing.folder && nextName !== name) {
          fs.renameSync(existing.folder, targetFolder)
        } else if (!existing.folder) {
          // 旧式平铺文件迁移为技能文件夹
          fs.mkdirSync(targetFolder, { recursive: true })
          if (existing.path !== path.join(targetFolder, 'SKILL.md')) {
            fs.writeFileSync(path.join(targetFolder, 'SKILL.md'), renderSkillFile({ name: nextName, title: body.title, description: body.description, triggers: body.triggers }, body.body || ''), 'utf-8')
            fs.rmSync(existing.path, { force: true })
            broadcast({ kind: 'skills-changed' })
            return json(res, 200, { ok: true, path: path.join(targetFolder, 'SKILL.md') })
          }
        }
        fs.mkdirSync(targetFolder, { recursive: true })
        fs.writeFileSync(
          path.join(targetFolder, 'SKILL.md'),
          renderSkillFile({ name: nextName, title: body.title, description: body.description, triggers: body.triggers }, body.body || ''),
          'utf-8'
        )
        broadcast({ kind: 'skills-changed' })
        return json(res, 200, { ok: true, path: path.join(targetFolder, 'SKILL.md') })
      }
      if (p === '/api/skills' && req.method === 'DELETE') {
        const name = url.searchParams.get('name') || ''
        const existing = listAllSkills().find((s) => s.name === name)
        if (!existing) return json(res, 404, { error: `技能 ${name} 不存在` })
        if (!existing.editable) return json(res, 403, { error: '内置技能不可删除' })
        if (existing.folder) fs.rmSync(existing.folder, { recursive: true, force: true })
        else fs.rmSync(existing.path, { force: true })
        broadcast({ kind: 'skills-changed' })
        return json(res, 200, { ok: true })
      }

      if (p === '/files' && req.method === 'GET') {
        return serveProjectFile(res, url.searchParams.get('path') || '')
      }

      res.writeHead(404)
      res.end('not found')
    } catch (e) {
      log('error', 'server', `${req.method} ${p} failed: ${String((e as Error).message || e)}`)
      json(res, 500, { error: String((e as Error).message || e) })
    }
  })

  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }: { req: http.IncomingMessage }) => {
      // browsers can't set headers on WebSocket: the token rides in the query string
      const u = new URL(req.url || '/ws', 'http://127.0.0.1')
      if (!tokenOk(req, u)) return false
      return !req.headers.origin || !!allowedOrigin(req)
    }
  })
  wss.on('connection', (sock: ClientSocket) => {
    sock.isAlive = true
    sock.on('pong', () => {
      sock.isAlive = true
    })
    sock.send(JSON.stringify({ kind: 'hello', agent: agentStatus() }))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(port))
  })
}
