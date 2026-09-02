// Doc-vs-code alignment gate: every tool the MCP server actually registers must be
// declared in agents/entropy.md as `entropy_<name>` (the orchestrator's tool menu),
// and vice versa — a declared-but-missing tool would make the agent hallucinate calls.
// Ground truth = a live tools/list against the real server over stdio JSON-RPC.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-check-tools-'))
const child = spawn(process.execPath, [path.resolve('mcp/server.mjs')], {
  env: { ...process.env, ED_PROJECT_DIR: proj, ED_SETTINGS_FILE: '', ED_SERVER_URL: '' },
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

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'doc-check', version: '0.0.0' }
})
const listed = await rpc('tools/list', {})
child.stdin.end()
child.kill()

/** @type {string[]} real tool names as registered by the MCP server */
const real = (listed.result?.tools || []).map((t) => t.name).sort()
if (real.length === 0) {
  console.error('tools/list returned nothing — MCP server broken?')
  process.exit(1)
}

const doc = fs.readFileSync('agents/entropy.md', 'utf-8')
/** @type {Set<string>} names the agent prompt declares, unprefixed */
const declared = new Set([...doc.matchAll(/entropy_([a-z_]+)/g)].map((m) => m[1]))

const missingInDoc = real.filter((n) => !declared.has(n))
const staleInDoc = [...declared].filter((n) => !real.includes(n))

if (missingInDoc.length || staleInDoc.length) {
  if (missingInDoc.length) console.error('tools registered but NOT declared in agents/entropy.md:\n  ' + missingInDoc.join('\n  '))
  if (staleInDoc.length) console.error('declared in agents/entropy.md but NOT registered:\n  ' + staleInDoc.join('\n  '))
  process.exit(1)
}
console.log(`agents/entropy.md matches the ${real.length} registered MCP tools ✔`)
