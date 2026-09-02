import { app, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Zero-dependency rotating file logger for the main process. Writes one line per
 * event to `%APPDATA%/entropy-design/logs/main-<YYYY-MM-DD>.log`, keeps the 7
 * newest files. Lines are appended synchronously (volume is low, and a synchronous
 * write survives the crashes we are trying to diagnose). Before initLogging() runs
 * (app boot), entries queue in memory and flush on init; the queue is capped so a
 * noisy early boot cannot grow unbounded.
 */

export type LogLevel = 'info' | 'warn' | 'error'

const KEEP_FILES = 7
const MAX_MSG_LEN = 2000
const QUEUE_CAP = 200

let inited = false
let today = ''
const queue: string[] = []

export function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function dateOf(d: Date): string {
  // local-date filenames: a user reporting "this morning's crash" maps to the file name
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fileFor(dateKey: string): string {
  return path.join(logsDir(), `main-${dateKey}.log`)
}

function pruneOldLogs(): void {
  try {
    const files = fs
      .readdirSync(logsDir())
      .filter((f) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort() // date names sort lexicographically = chronologically
      .reverse()
    for (const f of files.slice(KEEP_FILES)) {
      fs.rmSync(path.join(logsDir(), f), { force: true })
    }
  } catch {
    /* best-effort */
  }
}

export function initLogging(): void {
  if (inited) return
  inited = true
  try {
    fs.mkdirSync(logsDir(), { recursive: true })
    pruneOldLogs()
  } catch {
    inited = false // no writable log dir — stay on the memory queue
    return
  }
  const pending = queue.splice(0, queue.length)
  for (const line of pending) appendLine(line)
}

function appendLine(line: string): void {
  try {
    fs.appendFileSync(fileFor(today), line + '\n', 'utf-8')
  } catch {
    /* never let logging break the app */
  }
}

function write(level: LogLevel, scope: string, msg: string): void {
  const clean = String(msg).replace(/\r?\n/g, ' | ').slice(0, MAX_MSG_LEN)
  const d = new Date()
  const key = dateOf(d)
  if (key !== today) {
    today = key
    if (inited) pruneOldLogs()
  }
  const line = `${d.toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${clean}`
  if (!inited) {
    if (queue.length < QUEUE_CAP) queue.push(line)
    return
  }
  appendLine(line)
}

/** Write one log line: `log('info', 'agent', 'message')`. */
export function log(level: LogLevel, scope: string, msg: string): void {
  write(level, scope, msg)
}

/** Open the log folder in the OS file browser; returns an error string or ''. */
export async function openLogsFolder(): Promise<string> {
  try {
    fs.mkdirSync(logsDir(), { recursive: true })
    return await shell.openPath(logsDir())
  } catch (e) {
    return String((e as Error).message || e)
  }
}

/** Last ~N lines of the current log — for startup-failure dialogs / diagnostics. */
export function tailLogs(lines = 40): string {
  try {
    const raw = fs.readFileSync(fileFor(today), 'utf-8')
    return raw.trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}
