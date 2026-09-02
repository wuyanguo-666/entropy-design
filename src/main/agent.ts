import { spawn, execSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { loadSettings, settingsPath } from './settings'
import { cancelAllQuestions } from './questions'
import { log } from './log'

export interface AgentEvent {
  type: string
  properties: Record<string, unknown>
}

export interface AgentStatus {
  running: boolean
  projectDir: string | null
  sessionId: string | null
  baseUrl: string | null
  model: string | null
  error?: string
}

let proc: ChildProcess | null = null
let procProjectDir: string | null = null
let baseUrl: string | null = null
let sessionId: string | null = null
let eventAbort: AbortController | null = null
let onEvent: ((e: AgentEvent) => void) | null = null
let lastError: string | undefined
let serverPortNum = 8765
let serverToken = ''

/** The REST/WS port is dynamic (index.ts) — the MCP ask_user tool needs it. */
export function setServerPort(port: number): void {
  serverPortNum = port
}

/** One-time API token of this run — handed to the MCP child via ED_TOKEN. */
export function setServerToken(token: string): void {
  serverToken = token
}

export function setEventHandler(fn: (e: AgentEvent) => void): void {
  onEvent = fn
}

export function agentStatus(): AgentStatus {
  return {
    running: !!proc && !!baseUrl,
    projectDir: procProjectDir,
    sessionId,
    baseUrl,
    model: loadSettings().llm.activeModel,
    error: lastError
  }
}

/** Locate the opencode binary: explicit setting > official install > per-user install > PATH. */
export function resolveOpencodeBin(): string {
  const s = loadSettings()
  if (s.opencodeBin && fs.existsSync(s.opencodeBin)) return s.opencodeBin
  const candidates = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'), // opencode official installer
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', 'opencode.exe')
  ]
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return 'opencode' // assume on PATH; spawn errors surface a setup hint
}

/** Prefer system node; fall back to running Electron itself as node for MCP stdio. */
function nodeCommand(): { cmd: string; prefixEnv: Record<string, string> } {
  const paths = (process.env.PATH || '').split(path.delimiter)
  for (const dir of paths) {
    if (!dir) continue
    const candidate = path.join(dir, 'node.exe')
    try {
      if (fs.existsSync(candidate)) return { cmd: candidate, prefixEnv: {} }
    } catch {
      /* ignore */
    }
  }
  return { cmd: process.execPath, prefixEnv: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function mcpServerFile(): string {
  const devPath = path.resolve(__dirname, '../../mcp/server.mjs')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || __dirname, 'mcp', 'server.mjs')
}

export function skillsDir(): string {
  const devPath = path.resolve(__dirname, '../../skills')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || __dirname, 'skills')
}

/**
 * 用户技能文件夹（userData/skills）：新建/编辑的技能都归档在这里，
 * 同名时覆盖内置技能（用户目录优先）。
 */
export function userSkillsDir(): string {
  return path.join(app.getPath('userData'), 'skills')
}

export function knowledgeDir(): string {
  const devPath = path.resolve(__dirname, '../../knowledge')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || __dirname, 'knowledge')
}

export function workflowsDir(): string {
  const devPath = path.resolve(__dirname, '../../workflows')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || __dirname, 'workflows')
}

export function contractsDir(): string {
  const devPath = path.resolve(__dirname, '../../agents/contracts')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || __dirname, 'agents', 'contracts')
}

/** Bundled ffmpeg shipped via extraResources (packaged) or vendor/ (dev). May not exist — MCP side falls back to PATH. */
export function bundledFfmpegDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg')
  const vendor = path.resolve(__dirname, '../../vendor/ffmpeg')
  // 'current' is staged per-platform by tools/stage-ffmpeg.mjs; 'win' kept for
  // dev trees that fetched ffmpeg before staging existed
  for (const dir of ['current', process.platform === 'win32' ? 'win' : process.platform]) {
    if (fs.existsSync(path.join(vendor, dir))) return path.join(vendor, dir)
  }
  return path.join(vendor, 'current')
}

interface ContractFile {
  name: string
  agents: string[]
  body: string
}

/** Parse agents/contracts/*.md frontmatter (name, agents) + body. */
function loadContracts(): ContractFile[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(contractsDir()).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out: ContractFile[] = []
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(contractsDir(), f), 'utf-8').replace(/\r\n/g, '\n')
      const m = /^---\n([\s\S]*?)\n---/.exec(raw)
      const meta: Record<string, string> = {}
      if (m) {
        for (const line of m[1].split('\n')) {
          const kv = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())
          if (kv) meta[kv[1]] = kv[2].trim()
        }
      }
      const agents = (meta.agents || '')
        .replace(/[[\]]/g, '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      if (agents.length === 0) continue // opinionated: contracts must declare their audience
      out.push({
        name: meta.name || f.replace(/\.md$/, ''),
        agents,
        body: (m ? raw.slice(m[0].length) : raw).trim()
      })
    } catch {
      /* ignore unreadable contract */
    }
  }
  return out
}

/** Contracts for one agent (by name or '*'), rendered as <contract> blocks. */
export function contractsForAgent(agentName: string): string {
  const blocks = loadContracts()
    .filter((c) => c.agents.includes('*') || c.agents.includes(agentName))
    .map((c) => `<contract name="${c.name}">\n${c.body}\n</contract>`)
  return blocks.length ? '\n\n' + blocks.join('\n\n') : ''
}

function agentPromptFile(): string {
  const devPath = path.resolve(__dirname, '../../agents/entropy.md')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath || __dirname, 'agents', 'entropy.md')
}

/** Write opencode.json + agent markdown into the project. */
export function writeProjectOpencodeConfig(projectDir: string): void {
  const s = loadSettings()
  const edDir = path.join(projectDir, '.entropy')
  fs.mkdirSync(edDir, { recursive: true })
  fs.mkdirSync(path.join(projectDir, '.opencode', 'agent'), { recursive: true })

  const providers: Record<string, unknown> = {}
  for (const p of s.llm.providers) {
    if (!p.apiKey || !p.baseURL) continue
    const models: Record<string, { name: string }> = {}
    for (const m of p.models) models[m.id] = { name: m.name || m.id }
    providers[p.id] = {
      npm: '@ai-sdk/openai-compatible',
      name: p.name || p.id,
      options: { baseURL: p.baseURL, apiKey: p.apiKey },
      models
    }
  }

  const { cmd: nodeCmd, prefixEnv } = nodeCommand()

  // 外部 MCP 服务器（设置 → MCP）：合法名字 + 已启用的注入 opencode.json
  const externalMcp: Record<string, unknown> = {}
  for (const [name, srv] of Object.entries(s.mcp?.servers || {})) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || !srv?.enabled) continue
    if (srv.type === 'remote' && srv.url) {
      externalMcp[name] = {
        type: 'remote',
        enabled: true,
        url: srv.url,
        ...(srv.headers && Object.keys(srv.headers).length > 0 ? { headers: srv.headers } : {})
      }
    } else if (srv.type === 'local' && srv.command) {
      externalMcp[name] = {
        type: 'local',
        enabled: true,
        command: [srv.command, ...(srv.args || [])]
      }
    }
  }

  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    model: s.llm.activeModel,
    experimental: {
      // media generation (video) can legitimately run 10+ minutes per tool call
      mcp_timeout: 3600000
    },
    provider: providers,
    mcp: {
      entropy: {
        type: 'local',
        enabled: true,
        command: [nodeCmd, mcpServerFile()],
        environment: {
          ED_PROJECT_DIR: projectDir,
          ED_SETTINGS_FILE: settingsPath(),
          ED_SKILLS_DIR: skillsDir(),
          ED_USER_SKILLS_DIR: userSkillsDir(),
          ED_KNOWLEDGE_DIR: knowledgeDir(),
          ED_WORKFLOWS_DIR: workflowsDir(),
          ED_FFMPEG_DIR: bundledFfmpegDir(),
          ED_SERVER_URL: `http://127.0.0.1:${serverPortNum}`,
          ...(serverToken ? { ED_TOKEN: serverToken } : {}),
          ...prefixEnv
        }
      },
      ...externalMcp
    }
  }
  fs.writeFileSync(path.join(edDir, 'opencode.json'), JSON.stringify(config, null, 2), 'utf-8')
  // opencode reads opencode.json from the project root (cwd of the spawned process)
  fs.writeFileSync(path.join(projectDir, 'opencode.json'), JSON.stringify(config, null, 2), 'utf-8')

  // agent definition (markdown with frontmatter), also mirrored for both naming conventions
  const prompt = fs.readFileSync(agentPromptFile(), 'utf-8')
  const md = [
    '---',
    'description: Entropy Design creative canvas orchestrator. Plans creative work, calls entropy MCP tools to generate media and write canvas nodes.',
    'mode: primary',
    'temperature: 0.4',
    'permission:',
    '  edit: allow',
    '  bash: allow',
    '  webfetch: allow',
    '---',
    '',
    prompt
  ].join('\n')
  // contracts are spliced once at config-write time
  fs.writeFileSync(
    path.join(projectDir, '.opencode', 'agent', 'entropy.md'),
    md + contractsForAgent('entropy'),
    'utf-8'
  )

  // project instructions (AGENTS.md is auto-loaded as context)
  const agentsMd = path.join(projectDir, 'AGENTS.md')
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(
      agentsMd,
      [
        '# Project',
        '',
        'This is an Entropy Design AI creative project. Media assets live in the project folder;',
        'canvas state lives in `.entropy/canvas.json`. Use the entropy MCP tools for all media',
        'generation and canvas operations.',
        ''
      ].join('\n'),
      'utf-8'
    )
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function waitForServer(url: string, timeoutMs = 60000, failFast?: () => string | null): Promise<void> {
  // use raw http (not fetch) so no proxy/undici layer can interfere with loopback probes
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const fail = failFast?.()
    if (fail) throw new Error(fail)
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(`${url}/doc`, { timeout: 2000 }, (res) => {
        res.resume()
        resolve(!!res.statusCode && res.statusCode < 500)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('opencode server did not start in time')
}

/** Force-kill the opencode process tree on Windows (plain kill() can leave orphans). */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

async function startEventStream(): Promise<void> {
  if (!baseUrl) return
  eventAbort?.abort()
  eventAbort = new AbortController()
  const signal = eventAbort.signal
  try {
    const res = await fetch(`${baseUrl}/event`, { signal })
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line
        if (!payload) continue
        try {
          const evt = JSON.parse(payload) as AgentEvent
          onEvent?.(evt)
        } catch {
          /* partial or non-JSON line */
        }
      }
    }
  } catch (e) {
    if (!signal.aborted) {
      lastError = `event stream error: ${String(e)}`
      log('warn', 'agent', `${lastError} — reconnecting in 2s`)
      // attempt silent reconnect
      setTimeout(() => {
        if (proc && baseUrl) void startEventStream()
      }, 2000)
    }
  }
}

export async function startAgent(projectDir: string): Promise<AgentStatus> {
  lastError = undefined
  if (proc && procProjectDir === path.resolve(projectDir) && baseUrl) {
    return agentStatus()
  }
  await stopAgent()

  // clean up any stale instance left behind by a previous crashed/killed run
  try {
    const pidFile = path.join(app.getPath('userData'), 'opencode.pid')
    if (fs.existsSync(pidFile)) {
      const stale = Number(fs.readFileSync(pidFile, 'utf-8').trim())
      if (stale) killTree(stale)
      fs.rmSync(pidFile, { force: true })
    }
  } catch {
    /* ignore */
  }

  const resolved = path.resolve(projectDir)
  writeProjectOpencodeConfig(resolved)
  procProjectDir = resolved

  let lastAttemptError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = await startOnce(resolved)
      // remember pid for stale cleanup next launch
      try {
        const pidFile = path.join(app.getPath('userData'), 'opencode.pid')
        if (proc?.pid) fs.writeFileSync(pidFile, String(proc.pid), 'utf-8')
        void pidFile
      } catch {
        /* ignore */
      }
      return st
    } catch (e) {
      lastAttemptError = e
    }
  }
  throw new Error(`opencode failed to start: ${lastError || stderrTail || String(lastAttemptError)}`)
}

let stderrTail = ''
let spawnError: string | null = null

async function startOnce(resolved: string): Promise<AgentStatus> {
  const bin = resolveOpencodeBin()
  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`
  log('info', 'agent', `spawning ${bin} serve --port ${port} (cwd ${resolved})`)

  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: resolved,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LOGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  stderrTail = ''
  spawnError = null
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000)
  })
  child.on('error', (err: NodeJS.ErrnoException) => {
    lastError =
      err.code === 'ENOENT'
        ? '未找到 opencode 可执行文件。请在 设置 → 常规 填入 opencode 路径，或安装 opencode 后重试。'
        : `opencode spawn error: ${String(err)}`
    spawnError = lastError
    log('error', 'agent', lastError)
  })
  child.on('exit', (code) => {
    if (proc === child) {
      proc = null
      baseUrl = null
      sessionId = null
      procProjectDir = null
      lastError = `opencode exited (code ${code})${stderrTail ? `: ${stderrTail.slice(-800)}` : ''}`
      log('warn', 'agent', lastError)
      onEvent?.({ type: 'entropy.agent.stopped', properties: { reason: lastError } })
    }
  })
  proc = child

  try {
    await waitForServer(url, 60000, () => spawnError)
    baseUrl = url

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Entropy Design Session' })
    })
    if (!res.ok) throw new Error(`failed to create session: ${res.status} ${await res.text()}`)
    const session = (await res.json()) as { id: string }
    sessionId = session.id

    void startEventStream()
    log('info', 'agent', `ready at ${url} (session ${sessionId})`)
    return agentStatus()
  } catch (e) {
    // a failed start must not leak the spawned process — the retry spawns a fresh one
    log('error', 'agent', `start failed at ${url}: ${String((e as Error).message || e)}`)
    if (proc === child) {
      proc = null
      killTree(child.pid)
    }
    throw e
  }
}

export async function stopAgent(): Promise<void> {
  cancelAllQuestions()
  eventAbort?.abort()
  eventAbort = null
  if (proc) {
    const p = proc
    proc = null
    killTree(p.pid)
  }
  baseUrl = null
  sessionId = null
  procProjectDir = null
}

export async function sendPrompt(text: string): Promise<void> {
  if (!baseUrl || !sessionId) {
    throw new Error(
      lastError ? `agent 未运行：${lastError}` : 'agent 未运行（尚未启动或已退出，重新打开项目试试）'
    )
  }
  const s = loadSettings()
  const sep = s.llm.activeModel.indexOf('/')
  const providerID = sep > 0 ? s.llm.activeModel.slice(0, sep) : ''
  const modelID = sep > 0 ? s.llm.activeModel.slice(sep + 1) : ''
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text }],
    agent: 'entropy'
  }
  if (providerID && modelID) body.model = { providerID, modelID }
  const res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status !== 204 && !res.ok) {
    throw new Error(`prompt failed: ${res.status} ${await res.text()}`)
  }
}

export async function abortPrompt(): Promise<void> {
  if (!baseUrl || !sessionId) return
  await fetch(`${baseUrl}/session/${sessionId}/abort`, { method: 'POST' }).catch(() => {})
}

/** Full session history as {info, parts}[] for transcript backfill. */
export async function getHistory(): Promise<unknown[]> {
  if (!baseUrl || !sessionId) return []
  try {
    const res = await fetch(`${baseUrl}/session/${sessionId}/message`)
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? data : ((data as { messages?: unknown[] })?.messages ?? [])
  } catch {
    return []
  }
}

export async function ensureReady(): Promise<void> {
  if (!baseUrl || !sessionId) throw new Error('agent not running')
}

export function homeDir(): string {
  return os.homedir()
}
