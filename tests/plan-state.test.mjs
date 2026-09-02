// Unit tests for the Deliverable Plan state machine inside mcp/server.mjs.
// The server module is imported (not spawned): the isDirectRun guard keeps stdin
// untouched, and _testHooks exposes the registered tools. PROJECT_DIR must be set
// before the import, hence a fresh tmp dir per test file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-unit-plan-'))
process.env.ED_PROJECT_DIR = proj
process.env.ED_SETTINGS_FILE = ''
process.env.ED_SERVER_URL = ''

const { _testHooks } = await import('../mcp/server.mjs')
const { TOOLS, readPlan, readCanvas } = _testHooks

const text = (r) => r.content[0].text
const payload = (r) => JSON.parse(r.content[0].text)
const call = (name, args = {}) => TOOLS[name].run(args)

test('plan_create creates stages and mirrors a 执行计划 canvas node', async () => {
  const r = await call('plan_create', {
    goal: '15s 品牌广告',
    stages: [
      { name: '首帧样例', goal: '定风格' },
      { name: '逐镜生成' },
      { name: '配音合成' }
    ]
  })
  assert.ok(!r.isError, text(r))
  const p = payload(r)
  assert.equal(p.status, 'ok')
  assert.equal(p.stage_count, 3)
  assert.deepEqual(
    p.stages.map((s) => [s.id, s.order, s.status]),
    [
      ['s1', 1, 'waiting'],
      ['s2', 2, 'waiting'],
      ['s3', 3, 'waiting']
    ]
  )
  assert.match(p.next_action, /^execute stage 1/)

  const plan = readPlan()
  assert.ok(plan?.plan_id)
  const doc = readCanvas()
  const mirrors = doc.nodes.filter((n) => n.data?.planId === plan.plan_id)
  assert.equal(mirrors.length, 1)
  assert.equal(mirrors[0].data.name, '执行计划')
  assert.match(mirrors[0].data.text, /# 执行计划：15s 品牌广告/)
})

test('second plan_create is refused without replace; replace reuses the mirror node', async () => {
  const before = readPlan()
  const r = await call('plan_create', { goal: '另一个计划', stages: [{ name: 'x' }] })
  assert.ok(r.isError)
  assert.match(text(r), /an unfinished plan already exists/)

  const r2 = await call('plan_create', { goal: '另一个计划', stages: [{ name: 'x' }], replace: true })
  assert.ok(!r2.isError, text(r2))
  const after = readPlan()
  assert.notEqual(after.plan_id, before.plan_id)
  assert.equal(after.mirror_node_id, before.mirror_node_id) // recreated, not duplicated
  const doc = readCanvas()
  assert.equal(doc.nodes.filter((n) => n.type === 'text' && n.data?.name === '执行计划').length, 1)
})

test('plan_create input validation', async () => {
  const empty = await call('plan_create', { goal: 'g', stages: [], replace: true })
  assert.ok(empty.isError)
  assert.match(text(empty), /at least one stage/)
  const noGoal = await call('plan_create', { goal: '   ', stages: [{ name: 'a' }], replace: true })
  assert.ok(noGoal.isError)
  assert.match(text(noGoal), /requires a goal/)
  // restore the canonical plan for the next tests
  await call('plan_create', { goal: '15s 品牌广告', stages: [{ name: '首帧样例' }, { name: '逐镜生成' }, { name: '配音合成' }], replace: true })
})

test('stage transitions with CAS guard, waiting gate and deduped outputs', async () => {
  const doing = await call('plan_stage_state_update', { stage_id: 's1', status: 'doing', expected_status: 'waiting' })
  assert.ok(!doing.isError, text(doing))
  assert.match(payload(doing).next_action, /^continue stage 1/)

  // CAS: the stage already moved on — a stale expectation must fail loudly
  const stale = await call('plan_stage_state_update', { stage_id: 's1', status: 'done', expected_status: 'waiting' })
  assert.ok(stale.isError)
  assert.match(text(stale), /status changed: expected "waiting" but it is currently "doing"/)

  // review gate: waiting + result_review keeps the plan active and points at s1
  const gate = await call('plan_stage_state_update', { stage_id: 1, status: 'waiting', waiting_reason: 'result_review' })
  assert.ok(!gate.isError, text(gate)) // resolves by ORDER too (findStage)
  assert.match(payload(gate).next_action, /^execute stage 1/)

  const badReason = await call('plan_stage_state_update', { stage_id: 's1', status: 'doing', waiting_reason: 'plan_review' })
  assert.ok(badReason.isError)
  assert.match(text(badReason), /waiting_reason only applies/)

  const done = await call('plan_stage_state_update', { stage_id: 's1', status: 'done', outputs: ['first.png'] })
  assert.ok(!done.isError, text(done))
  const again = await call('plan_stage_state_update', { stage_id: 's1', status: 'done', outputs: ['first.png', 'first.png', 'v1.mp4'] })
  assert.ok(!again.isError, text(again))
  assert.deepEqual(payload(again).stages[0].outputs, ['first.png', 'v1.mp4'])

  const ghost = await call('plan_stage_state_update', { stage_id: 's9', status: 'done' })
  assert.ok(ghost.isError)
  assert.match(text(ghost), /stage not found: s9/)
})

test('finished plan: next_action asks for the summary, patch is refused', async () => {
  for (const id of ['s2', 's3']) {
    const r = await call('plan_stage_state_update', { stage_id: id, status: 'done' })
    assert.ok(!r.isError, text(r))
  }
  const status = payload(await call('plan_stage_status'))
  assert.equal(status.status, 'finished')
  assert.match(status.next_action, /all stages done/)

  const patch = await call('plan_stage_patch', { name: '追加' })
  assert.ok(patch.isError)
  assert.match(text(patch), /plan is finished/)

  // patching an ACTIVE plan appends at the end
  await call('plan_create', { goal: 'active', stages: [{ name: 'a' }], replace: true })
  const added = payload(await call('plan_stage_patch', { name: 'b' }))
  assert.equal(added.stage_count, 2)
  assert.equal(added.stages[1].id, 's2')
  assert.equal(added.stages[1].status, 'waiting')
})

test('next_action priority: doing > blocked > waiting', async () => {
  await call('plan_create', { goal: 'prio', stages: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], replace: true })
  await call('plan_stage_state_update', { stage_id: 's1', status: 'waiting', waiting_reason: 'plan_review' })
  await call('plan_stage_state_update', { stage_id: 's2', status: 'blocked', note: 'api down' })
  assert.match(payload(await call('plan_stage_status')).next_action, /^stage 2 .*blocked/)
  await call('plan_stage_state_update', { stage_id: 's1', status: 'doing' })
  assert.match(payload(await call('plan_stage_status')).next_action, /^continue stage 1/)
})
