// Home task-queue plumbing: MCP generation tools mirror started/completed/failed
// events to the main process via fire-and-forget POST /api/agent/task-event.
// This stubs that endpoint (plus a tiny OpenAI-compatible image API) and drives
// the real MCP server over stdio JSON-RPC.
import { spawn } from 'node:child_process'
import * as http from 'node:http'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const PORT = 18766
const BASE = `http://127.0.0.1:${PORT}`
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** @type {any[]} task-event payloads, in arrival order */
const received = []

const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/api/agent/task-event' && req.method === 'POST') {
      try {
        received.push(JSON.parse(body))
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url === '/v1/images/generations' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
})
await new Promise((r) => stub.listen(PORT, '127.0.0.1', r))

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-task-'))
const settingsFile = path.join(proj, 'settings.json')
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ image: { openai: { enabled: true, apiKey: 'sk-test', baseURL: `${BASE}/v1`, model: 'gpt-image-test' } } })
)

const child = spawn(process.execPath, [path.resolve('mcp/server.mjs')], {
  env: { ...process.env, ED_PROJECT_DIR: proj, ED_SETTINGS_FILE: settingsFile, ED_SERVER_URL: BASE },
  stdio: ['pipe', 'pipe', 'inherit']
})
let buf = ''
const pending = new Map()
child.stdout.setEncoding('utf-8')
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg)
    }
  }
})
let nextId = 1
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
/** Poll until cond() is true or ms elapses. */
function waitFor(cond, ms = 5000) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (cond()) return resolve(true)
      if (Date.now() - t0 > ms) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}
const forKind = (kind, status) => received.filter((e) => e.kind === kind && (!status || e.status === status))
// canvas.json write happens synchronously just before the reportTask POST,
// so the file appearing proves the event is already in flight
const canvasHasNode = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(proj, '.entropy', 'canvas.json'), 'utf-8')).nodes.length > 0
  } catch {
    return false
  }
}

const fails = []
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + detail}`)
  if (!cond) fails.push(name)
}

await rpc('initialize', { protocolVersion: '2024-11-05' })

// 1. happy path: image generation reports started then completed (with file + seconds)
const imgRes = await rpc('tools/call', { name: 'image_generate', arguments: { prompt: '一只柴犬', save_name: 'shiba' } })
check('image tool succeeded', !imgRes.result?.isError, JSON.stringify(imgRes.result ?? imgRes).slice(0, 200))
await waitFor(canvasHasNode)
await waitFor(() => forKind('image', 'completed').length > 0)
const imgStarted = forKind('image', 'started')
const imgDone = forKind('image', 'completed')
check('started event carries project + prompt', imgStarted.length === 1 && imgStarted[0].projectDir === proj && imgStarted[0].prompt.includes('柴犬'), JSON.stringify(imgStarted))
check('completed event carries file + seconds', imgDone.length === 1 && String(imgDone[0].file || '').startsWith('generated/shiba') && typeof imgDone[0].seconds === 'number', JSON.stringify(imgDone))
check('started/completed share one taskId', imgStarted[0]?.taskId === imgDone[0]?.taskId)

// 2. error-return path: unconfigured TTS still reports failed (isError result branch)
const ttsRes = await rpc('tools/call', { name: 'speech_generate', arguments: { text: '你好' } })
check('speech tool returns isError when unconfigured', !!ttsRes.result?.isError)
await new Promise((r) => setTimeout(r, 100))
await waitFor(() => forKind('audio', 'failed').length > 0)
check('audio failed event emitted', forKind('audio', 'failed').length === 1, JSON.stringify(forKind('audio')))

// 3. throw path: video with no provider configured reports failed via the catch branch
const vidRes = await rpc('tools/call', { name: 'video_generate', arguments: { prompt: '奔跑的马' } })
check('video tool errors when unconfigured', !!vidRes.result?.isError, JSON.stringify(vidRes.result ?? vidRes).slice(0, 200))
await new Promise((r) => setTimeout(r, 100))
await waitFor(() => forKind('video', 'failed').length > 0)
check('video failed event emitted', forKind('video', 'failed').length === 1, JSON.stringify(forKind('video')))

// 4. non-generation tools emit nothing
const before = received.length
await rpc('tools/call', { name: 'canvas_node_add_text', arguments: { text: 'x', name: 'note' } })
await new Promise((r) => setTimeout(r, 300))
check('plain canvas tool emits no task events', received.length === before, `${before} -> ${received.length}`)

child.kill()
stub.close()
fs.rmSync(proj, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
