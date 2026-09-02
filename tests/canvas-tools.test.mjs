// Unit tests for the P3-2 canvas additions: table node normalization and the
// atomic incremental text editor. Same import strategy as plan-state tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-unit-canvas-'))
process.env.ED_PROJECT_DIR = proj
process.env.ED_SETTINGS_FILE = ''
process.env.ED_SERVER_URL = ''

const { _testHooks } = await import('../mcp/server.mjs')
const { TOOLS, readCanvas } = _testHooks

const text = (r) => r.content[0].text

test('canvas_node_add_table normalizes ragged rows to the column width', async () => {
  const r = await TOOLS.canvas_node_add_table.run({
    name: '分镜表',
    columns: ['镜头', '时长', '画面', '旁白'],
    rows: [
      ['1', '3s', '产品特写'],
      ['2', '4s', '使用场景', '第一句', '溢出的第5列']
    ]
  })
  assert.ok(!r.isError, text(r))
  const node = readCanvas().nodes.find((n) => n.type === 'table')
  assert.equal(node.data.table.columns.length, 4)
  assert.deepEqual(node.data.table.rows[0], ['1', '3s', '产品特写', ''])
  assert.equal(node.data.table.rows[1].length, 4)
})

test('canvas_node_add_table rejects too-few columns', async () => {
  const r = await TOOLS.canvas_node_add_table.run({ name: 't', columns: ['a'], rows: [['1']] })
  assert.ok(r.isError)
  assert.match(text(r), /at least 2 columns/)
})

test('canvas_text_patch replaces all occurrences; batch is atomic', async () => {
  const created = await TOOLS.canvas_node_add_text.run({ name: 'brief', text: '蓝色 蓝色 结尾' })
  const id = text(created).match(/id=([a-f0-9-]+)/)[1]

  const miss = await TOOLS.canvas_text_patch.run({
    node_id: id,
    edits: [{ find: '蓝色', replace: '金色' }, { find: '不存在', replace: 'x' }]
  })
  assert.ok(miss.isError)
  assert.match(text(miss), /nothing was changed \(batch is atomic\)/)
  assert.equal(readCanvas().nodes.find((n) => n.id === id).data.text, '蓝色 蓝色 结尾') // untouched

  const ok = await TOOLS.canvas_text_patch.run({
    node_id: id,
    edits: [{ find: '蓝色', replace: '金色' }, { find: '结尾', replace: '' }]
  })
  assert.ok(!ok.isError, text(ok))
  assert.equal(readCanvas().nodes.find((n) => n.id === id).data.text, '金色 金色 ')
})

test('canvas_text_patch only touches text nodes', async () => {
  const tbl = await TOOLS.canvas_node_add_table.run({ name: 'grid', columns: ['a', 'b'], rows: [['1', '2']] })
  const id = text(tbl).match(/id=([a-f0-9-]+)/)[1]
  const r = await TOOLS.canvas_text_patch.run({ node_id: id, edits: [{ find: 'a', replace: 'b' }] })
  assert.ok(r.isError)
  assert.match(text(r), /only edits text nodes/)
})
