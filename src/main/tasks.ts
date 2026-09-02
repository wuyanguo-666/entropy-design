import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentTask, TaskStatus } from '../shared/types'
import { log } from './log'

/**
 * In-memory mirror of MCP generation tasks (video/image/audio/music), reported
 * fire-and-forget by mcp/server.mjs via POST /api/agent/task-event. The single
 * opencode agent is serial, so "queue" means "across agent lifetimes": switching
 * projects kills in-flight tool calls; those are marked interrupted by the
 * entropy.agent.stopped handler rather than lingering as running.
 *
 * Every mutation is appended to userData/tasks.jsonl so the home queue survives
 * restarts. Nothing is actually generating after a main-process restart, so
 * initTasks() reconciles: restored rows still marked running become interrupted.
 */

const MAX_TASKS = 50
const tasks = new Map<string, AgentTask>() // insertion-ordered by arrival

function tasksFile(): string {
  return path.join(app.getPath('userData'), 'tasks.jsonl')
}

function appendTask(t: AgentTask): void {
  try {
    fs.appendFile(tasksFile(), JSON.stringify(t) + '\n', 'utf-8', (err) => {
      if (err) log('warn', 'tasks', `append failed: ${String(err.message || err)}`)
    })
  } catch (e) {
    log('warn', 'tasks', `append failed: ${String((e as Error).message || e)}`)
  }
}

/** Rewrite the file from current state (drops superseded duplicate rows). */
function persistSnapshot(): void {
  try {
    const file = tasksFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    const body = [...tasks.values()].map((t) => JSON.stringify(t)).join('\n')
    fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    log('warn', 'tasks', `snapshot rewrite failed: ${String((e as Error).message || e)}`)
  }
}

/**
 * Load history from disk, reconcile leftover running rows to interrupted, and
 * compact the file. Returns how many tasks were marked interrupted.
 */
export function initTasks(): number {
  let interrupted = 0
  try {
    const file = tasksFile()
    if (!fs.existsSync(file)) return 0
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      let t: AgentTask
      try {
        t = JSON.parse(line) as AgentTask
      } catch {
        continue // torn line from a hard kill — skip
      }
      if (!t?.taskId || !t.status) continue
      if (t.status === 'running') {
        t.status = 'interrupted'
        t.endedAt = t.endedAt || Date.now()
        t.error = t.error || '应用重启，生成中断'
        interrupted++
      }
      tasks.set(t.taskId, t)
    }
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value
      if (oldest === undefined) break
      tasks.delete(oldest)
    }
    persistSnapshot()
  } catch (e) {
    log('warn', 'tasks', `history load failed: ${String((e as Error).message || e)}`)
  }
  return interrupted
}

export interface TaskEventPayload {
  taskId?: string
  status?: string
  kind?: string
  projectDir?: string
  provider?: string
  model?: string
  prompt?: string
  file?: string
  error?: string
  seconds?: number
}

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'interrupted']

export function applyTaskEvent(ev: TaskEventPayload): AgentTask | null {
  if (!ev?.taskId || !ev.status) return null
  const now = Date.now()
  let t = tasks.get(ev.taskId)
  if (!t) {
    // only a started/running event establishes context; ignore orphans otherwise
    if (ev.status !== 'started' && ev.status !== 'running') return null
    if (!ev.projectDir || !ev.kind) return null
    t = {
      taskId: ev.taskId,
      kind: ev.kind as AgentTask['kind'],
      status: 'running',
      projectDir: ev.projectDir,
      startedAt: now
    }
  }
  if (ev.kind && ev.kind !== 'unknown') t.kind = ev.kind as AgentTask['kind']
  if (ev.projectDir) t.projectDir = ev.projectDir
  if (ev.provider) t.provider = ev.provider
  if (ev.model) t.model = ev.model
  if (ev.prompt) t.prompt = ev.prompt
  if (ev.file) t.file = ev.file
  if (ev.error) t.error = ev.error
  const mapped: TaskStatus =
    ev.status === 'started' || ev.status === 'running' ? 'running' : (TERMINAL as string[]).includes(ev.status) ? (ev.status as TaskStatus) : t.status
  if (mapped !== t.status) t.status = mapped
  if (t.status !== 'running' && !t.endedAt) {
    t.endedAt = now
    if (typeof ev.seconds === 'number' && ev.seconds >= 0) t.seconds = ev.seconds
    else t.seconds = Math.max(0, Math.round((now - t.startedAt) / 1000))
  }
  tasks.set(ev.taskId, t)
  let dropped = false
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next().value
    if (oldest === undefined) break
    tasks.delete(oldest)
    dropped = true
  }
  appendTask(t)
  if (dropped) persistSnapshot() // evictions can't be expressed by an append
  return t
}

/** Mark every running task interrupted (agent process died mid-generation). */
export function interruptRunningTasks(): AgentTask[] {
  const changed: AgentTask[] = []
  for (const t of tasks.values()) {
    if (t.status === 'running') {
      t.status = 'interrupted'
      t.endedAt = Date.now()
      t.error = 'agent 已停止（切换项目或重启），生成中断'
      changed.push(t)
      appendTask(t)
    }
  }
  return changed
}

export function listTasks(): AgentTask[] {
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
}
