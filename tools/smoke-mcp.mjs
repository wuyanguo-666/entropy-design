// MCP smoke test: exercises the new ask_user/selection/group tools end-to-end via stdio JSON-RPC.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-smoke-'))
const serverPath = path.resolve('mcp/server.mjs')
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, ED_PROJECT_DIR: proj, ED_SETTINGS_FILE: '' },
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
async function call(tool, args = {}) {
  const res = await rpc('tools/call', { name: tool, arguments: args })
  return res.result?.content?.[0]?.text ?? JSON.stringify(res)
}

const fails = []
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + detail}`)
  if (!cond) fails.push(name)
}

await rpc('initialize', { protocolVersion: '2024-11-05' })
const list = await rpc('tools/list', {})
const names = list.result.tools.map((t) => t.name)
for (const t of ['ask_user', 'canvas_selection_read', 'canvas_outputs_group', 'canvas_nodes_group', 'canvas_node_ungroup']) {
  check(`tools/list has ${t}`, names.includes(t))
}

// create 3 nodes
for (const n of ['a', 'b', 'c']) await call('canvas_node_add_text', { name: n, text: `content ${n}` })
const grouped = JSON.parse(await call('canvas_outputs_group', { label: '测试分组' }))
check('group_recent_outputs groups 3 nodes', grouped.status === 'ok' && grouped.grouped.length === 3, JSON.stringify(grouped))

const doc1 = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const group = doc1.nodes.find((n) => n.type === 'group')
const childNodes = doc1.nodes.filter((n) => n.parentId === group.id)
check('group node created with 3 children', !!group && childNodes.length === 3)
check('children inside group bounds', childNodes.every((n) => n.positions.main.x >= group.positions.main.x && n.positions.main.y >= group.positions.main.y))

const again = JSON.parse(await call('canvas_outputs_group', { label: 'x' }))
check('group_recent_outputs idempotent', again.status === 'no-op', JSON.stringify(again))

const dissolved = await call('canvas_node_ungroup', { node_id: group.id })
const doc2 = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
check('ungroup dissolves group', dissolved.includes('group dissolved') && !doc2.nodes.some((n) => n.type === 'group') && doc2.nodes.every((n) => !n.parentId))

// selection
fs.mkdirSync(path.join(proj, '.entropy'), { recursive: true })
const firstNode = doc2.nodes.find((n) => n.type === 'text')
fs.writeFileSync(path.join(proj, '.entropy/selection.json'), JSON.stringify({ nodeIds: [firstNode.id] }))
const sel = JSON.parse(await call('canvas_selection_read'))
check('canvas_selection_read returns selected node', sel.count === 1 && sel.nodes[0].id === firstNode.id, JSON.stringify(sel))

// ask_user without server → graceful error
const ask = await call('ask_user', { questions: [{ question: '比例?', options: ['16:9（推荐）', '9:16'] }] })
check('ask_user fails gracefully without ED_SERVER_URL', ask.includes('ask_user unavailable'), ask.slice(0, 120))

// group_nodes manual path
const ids = doc2.nodes.filter((n) => n.type === 'text').map((n) => n.id)
const manual = JSON.parse(await call('canvas_nodes_group', { node_ids: ids.slice(0, 2), label: '手动分组' }))
check('canvas_nodes_group works', manual.status === 'ok' && manual.grouped === 2, JSON.stringify(manual))

// file import type detection (regression: non-image files must not become video nodes)
const tmpMp3 = path.join(proj, 'sample.mp3')
fs.writeFileSync(tmpMp3, 'fake-mp3-bytes')
const mp3Res = await call('canvas_node_add_file', { source_path: tmpMp3, name: 'sample' })
check('audio import becomes audio node', mp3Res.startsWith('audio node created'), mp3Res.slice(0, 120))
const tmpTxt = path.join(proj, 'note.txt')
fs.writeFileSync(tmpTxt, 'hello')
const txtRes = await call('canvas_node_add_file', { source_path: tmpTxt, name: 'note' })
check('text import becomes file node', txtRes.startsWith('file node created'), txtRes.slice(0, 120))

// content dedupe: importing the same bytes again reuses the existing node
const mp3Again = await call('canvas_node_add_file', { source_path: tmpMp3, name: 'sample' })
const docDedupe = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const mp3Nodes = docDedupe.nodes.filter((n) => n.type === 'audio')
check('duplicate import reuses node (no dup)', mp3Again.startsWith('node reused') && mp3Nodes.length === 1, mp3Again.slice(0, 120) + ` audioNodes=${mp3Nodes.length}`)

// ---- plan tools ----
check('tools/list has plan tools', ['plan_create', 'plan_stage_patch', 'plan_stage_status', 'plan_stage_state_update'].every((t) => names.includes(t)))

const noPlan = JSON.parse(await call('plan_stage_status'))
check('plan_stage_status without plan', noPlan.status === 'no-plan', JSON.stringify(noPlan))

const created = JSON.parse(await call('plan_create', {
  goal: '15s 品牌成片',
  stages: [
    { name: '首帧样例', goal: '出 2 张候选' },
    { name: '逐镜生成', goal: '3 镜视频' },
    { name: '配音', goal: '正式旁白' }
  ]
}))
check('plan_create creates plan', created.status === 'ok' && created.stage_count === 3 && created.next_action.includes('stage 1'), JSON.stringify(created))

const dup = await call('plan_create', { goal: 'x', stages: [{ name: 'y' }] })
check('plan_create rejects active plan', dup.includes('unfinished plan already exists'), dup.slice(0, 120))

const patched = JSON.parse(await call('plan_stage_patch', { name: '合成', goal: 'merge' }))
check('plan_stage_patch appends', patched.stage_count === 4 && patched.stages[3].id === 's4', JSON.stringify(patched))

const doing = JSON.parse(await call('plan_stage_state_update', { stage_id: 's1', status: 'doing', expected_status: 'waiting' }))
check('plan_update doing with CAS', doing.stages[0].status === 'doing' && doing.next_action.includes('continue stage 1'), JSON.stringify(doing))

const casFail = await call('plan_stage_state_update', { stage_id: 's1', status: 'done', expected_status: 'waiting' })
check('CAS mismatch rejected', casFail.includes('status changed'), casFail.slice(0, 160))

const done = JSON.parse(await call('plan_stage_state_update', { stage_id: 's1', status: 'done', outputs: ['sample-01.png'] }))
check('plan_update done + outputs', done.stages[0].status === 'done' && done.stages[0].outputs[0] === 'sample-01.png' && done.next_action.includes('stage 2'), JSON.stringify(done))

const mirrorDoc = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const mirror = mirrorDoc.nodes.find((n) => n.data?.planId)
check('plan mirror text node on canvas', !!mirror && mirror.type === 'text' && mirror.data.text.includes('首帧样例') && mirror.data.text.includes('✅'), mirror?.data?.text?.slice(0, 120))

const planFile = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/plan.json'), 'utf-8'))
check('plan.json mirror_node_id recorded', planFile.mirror_node_id === mirror.id)

const blocked = JSON.parse(await call('plan_stage_state_update', { stage_id: 's2', status: 'blocked', note: 'kling key missing' }))
check('plan_update blocked + note', blocked.stages[1].status === 'blocked' && blocked.next_action.includes('blocked'), JSON.stringify(blocked))

const replaced = JSON.parse(await call('plan_create', { goal: '重立计划', stages: [{ name: '唯一阶段' }], replace: true }))
check('plan_create replace:true replans', replaced.status === 'ok' && replaced.stage_count === 1 && replaced.goal === '重立计划', JSON.stringify(replaced))
const mirrorDoc2 = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const mirrors = mirrorDoc2.nodes.filter((n) => n.data?.planId)
check('replan reuses mirror node', mirrors.length === 1 && mirrors[0].data.text.includes('唯一阶段'), `mirrors=${mirrors.length}`)

// ---- knowledge search ----
check('tools/list has knowledge_search', names.includes('knowledge_search'))
const hit = JSON.parse(await call('knowledge_search', { query: '视频 超时 轮询 重试' }))
check('knowledge_search hits video-task-lifecycle', hit.matches?.[0]?.name === 'video-task-lifecycle' && typeof hit.matches[0].full_text === 'string', JSON.stringify(hit).slice(0, 200))
const miss = JSON.parse(await call('knowledge_search', { query: 'zzqqxx 鑫淼焱' }))
check('knowledge_search miss returns empty', Array.isArray(miss.matches) && miss.matches.length === 0, JSON.stringify(miss).slice(0, 200))

// ---- comfy tools (offline: no ComfyUI backend) ----
check('tools/list has comfy tools', ['comfy_list_workflows', 'comfy_get_workflow', 'comfy_run_workflow'].every((t) => names.includes(t)))
const wfList = JSON.parse(await call('comfy_list_workflows'))
check('comfy_list_workflows shows builtin', Array.isArray(wfList.workflows) && wfList.workflows.some((w) => w.name === 'builtin-txt2img'), JSON.stringify(wfList).slice(0, 200))
check('comfy reports disabled state', wfList.comfyui?.enabled === false, JSON.stringify(wfList.comfyui))
const wfRun = await call('comfy_run_workflow', { prompt: 'test' })
check('comfy_run_workflow fails readable when disabled', wfRun.includes('ComfyUI 未启用'), wfRun.slice(0, 120))

child.kill()
fs.rmSync(proj, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
