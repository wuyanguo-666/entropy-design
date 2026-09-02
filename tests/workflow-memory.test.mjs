// Unit tests for the P3-1 workflow playbooks and P3-3 per-project memory tools.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// point the module at a scratch workflows dir BEFORE import (env read at module load)
const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-unit-wf-'))
fs.writeFileSync(
  path.join(wfDir, 'demo.md'),
  '---\nname: demo\ntitle: 演示剧本\ndescription: d\nwhen: 测试\n---\n\n# 步骤\n先做 A，⛳ 确认，再做 B。\n'
)
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-unit-mem-'))
process.env.ED_PROJECT_DIR = proj
process.env.ED_SETTINGS_FILE = ''
process.env.ED_SERVER_URL = ''
process.env.ED_WORKFLOWS_DIR = wfDir

const { _testHooks } = await import('../mcp/server.mjs')
const { TOOLS } = _testHooks
const text = (r) => r.content[0].text
const payload = (r) => JSON.parse(r.content[0].text)

test('list_workflows reads frontmatter; load_workflow returns the body only', async () => {
  const list = payload(await TOOLS.list_workflows.run({}))
  assert.equal(list.workflows.length, 1)
  assert.deepEqual(list.workflows[0], { name: 'demo', title: '演示剧本', description: 'd', when: '测试' })
  const loaded = await TOOLS.load_workflow.run({ name: 'demo' })
  assert.ok(!loaded.isError)
  assert.match(text(loaded), /^# 步骤/)
  assert.ok(!text(loaded).includes('name: demo')) // frontmatter stripped
  const miss = await TOOLS.load_workflow.run({ name: 'ghost' })
  assert.ok(miss.isError)
  assert.match(text(miss), /workflow not found/)
})

test('official playbooks ship with the repo and parse', async () => {
  process.env.ED_WORKFLOWS_DIR = ''
  // default dir = repo workflows/ — validate the two official files directly
  const repoWf = path.resolve('workflows')
  const names = fs.readdirSync(repoWf).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  assert.deepEqual(names.sort(), ['brand-tvc', 'mv-storyboard'])
  for (const n of names) {
    const raw = fs.readFileSync(path.join(repoWf, `${n}.md`), 'utf-8')
    assert.match(raw, new RegExp(`^---\\nname: ${n}`), `${n}: frontmatter name must match the file`)
    assert.match(raw, /title: .+/, `${n}: needs a title`)
    assert.match(raw, /when: .+/, `${n}: needs a when trigger`)
  }
})

test('remember writes an atomic card; recall finds it by tags and body', async () => {
  const r = await TOOLS.remember.run({ title: '品牌主色 #1A73E8', body: '所有画面与字幕必须使用品牌蓝，用户 2026-09 确认。', tags: ['Brand', '颜色'] })
  assert.ok(!r.isError, text(r))
  const match = text(r).match(/remembered: (\S+) /)
  assert.ok(match)
  const card = fs.readFileSync(path.join(proj, '.entropy', 'memory', match[1]), 'utf-8')
  assert.match(card, /title: 品牌主色 #1A73E8/)
  assert.match(card, /tags: brand, 颜色/) // normalized lowercase

  const hit = payload(await TOOLS.recall.run({ query: '品牌 颜色' }))
  assert.equal(hit.matches.length, 1)
  assert.match(hit.matches[0].body, /品牌蓝/)
  const none = payload(await TOOLS.recall.run({ query: '完全不相干的关键词xyz' }))
  assert.equal(none.matches.length, 0)
})

test('remember rejects empty content; recall needs a query', async () => {
  assert.ok((await TOOLS.remember.run({ title: 'x', body: '  ' })).isError)
  assert.ok((await TOOLS.remember.run({ title: '', body: 'y' })).isError)
  assert.ok((await TOOLS.recall.run({ query: '' })).isError)
})
