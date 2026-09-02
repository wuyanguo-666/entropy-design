// ask_user end-to-end test: MCP tool (node:http transport) <-> stub of the main-process endpoints.
import { spawn } from 'node:child_process'
import * as http from 'node:http'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const PORT = 18765
const BASE = `http://127.0.0.1:${PORT}`
let mode = 'answer'

const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/api/agent/question') {
      const parsed = JSON.parse(body)
      if (mode === 'error') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      if (mode === 'cancel') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ cancelled: true }))
        return
      }
      const delay = mode === 'slow' ? 6000 : 300
      // simulate the renderer answering via the answer endpoint
      setTimeout(() => {
        const ans = JSON.stringify({ id: 'stub', answers: parsed.questions.map((q) => [q.options[0]]) })
        const r = http.request(`${BASE}/api/agent/question/answer`, { method: 'POST', headers: { 'content-type': 'application/json' } })
        r.end(ans)
      }, delay)
      // hold the response open until answered (like the real server's pending-question promise)
      const started = Date.now()
      const tick = setInterval(() => {
        if (Date.now() - started > delay + 1500) {
          clearInterval(tick)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ answers: parsed.questions.map((q) => [q.options[0]]) }))
        }
      }, 100)
      return
    }
    if (req.url === '/api/agent/question/answer') {
      res.writeHead(200)
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404)
    res.end()
  })
})
await new Promise((r) => stub.listen(PORT, '127.0.0.1', r))

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-ask-'))
const child = spawn(process.execPath, [path.resolve('mcp/server.mjs')], {
  env: { ...process.env, ED_PROJECT_DIR: proj, ED_SETTINGS_FILE: '', ED_SERVER_URL: BASE },
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
async function ask(questions) {
  const res = await rpc('tools/call', { name: 'ask_user', arguments: { questions } })
  return res.result?.content?.[0]?.text ?? JSON.stringify(res)
}

const fails = []
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + detail}`)
  if (!cond) fails.push(name)
}

await rpc('initialize', { protocolVersion: '2024-11-05' })

mode = 'answer'
let out = await ask([
  { question: '画面比例', options: ['16:9（推荐）', '9:16'] },
  { question: '配音', options: ['要（推荐）', '不要'], multiSelect: false }
])
check('happy path returns answers', out.includes('16:9（推荐）') && out.includes('要（推荐）'), out)
check('happy path tells agent to proceed', out.includes('proceed with the next step'), out)

mode = 'cancel'
out = await ask([{ question: '风格', options: ['A（推荐）', 'B'] }])
check('cancel path returns cancelled error', out.includes('dismissed'), out)

mode = 'error'
out = await ask([{ question: '风格', options: ['A（推荐）', 'B'] }])
check('server 500 falls back to inline options', out.includes('Fall back to plain-text'), out)

mode = 'slow'
const t0 = Date.now()
out = await ask([{ question: '首帧', options: ['样例1（推荐）', '样例2'] }])
check('6s wait still answered (no premature timeout)', out.includes('样例1（推荐）'), out)
console.log(`      waited ${Math.round((Date.now() - t0) / 1000)}s`)

mode = 'answer'
out = await ask([{ question: '空问题', options: [] }])
check('invalid questions rejected', out.includes('requires at least one question'), out)

child.kill()
stub.close()
fs.rmSync(proj, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
