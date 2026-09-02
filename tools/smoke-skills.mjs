// Skills smoke: exercises the two-directory scan (builtin + user, user wins) and the
// flat <name>.md vs folder <name>/SKILL.md layouts via stdio JSON-RPC.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-skills-'))
const builtinDir = path.join(proj, 'builtin-skills')
const userDir = path.join(proj, 'user-skills')
fs.mkdirSync(builtinDir, { recursive: true })
fs.mkdirSync(userDir, { recursive: true })

// builtin: flat layout
fs.writeFileSync(
  path.join(builtinDir, 'brand-poster.md'),
  '---\nname: brand-poster\ntitle: 品牌主视觉\ndescription: builtin poster skill\ntriggers: 海报\n---\n\n# Builtin poster\n'
)
// builtin: folder layout
fs.mkdirSync(path.join(builtinDir, 'storyboard'), { recursive: true })
fs.writeFileSync(
  path.join(builtinDir, 'storyboard', 'SKILL.md'),
  '---\nname: storyboard\ntitle: 分镜故事板\ndescription: builtin storyboard\ntriggers: 分镜\n---\n\n# Builtin storyboard\n'
)
fs.mkdirSync(path.join(builtinDir, 'storyboard', 'references'), { recursive: true })
fs.writeFileSync(path.join(builtinDir, 'storyboard', 'references', 'framing.md'), '# framing notes\n')
// user: overrides builtin by name
fs.mkdirSync(path.join(userDir, 'storyboard'), { recursive: true })
fs.writeFileSync(
  path.join(userDir, 'storyboard', 'SKILL.md'),
  '---\nname: storyboard\ntitle: 用户分镜\ndescription: user storyboard wins\ntriggers: 分镜\n---\n\n# User storyboard\n'
)
// user-only skill
fs.writeFileSync(
  path.join(userDir, 'my-skill.md'),
  '---\nname: my-skill\ntitle: 我的技能\ndescription: user only\ntriggers: 自定义\n---\n\n# My skill\n'
)

const serverPath = path.resolve('mcp/server.mjs')
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    ED_PROJECT_DIR: proj,
    ED_SETTINGS_FILE: '',
    ED_SKILLS_DIR: builtinDir,
    ED_USER_SKILLS_DIR: userDir
  },
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

const list = JSON.parse(await call('list_skills'))
const byName = new Map(list.skills.map((s) => [s.name, s]))
check('lists all 3 skills', list.skills.length === 3, JSON.stringify(list))
check('user overrides builtin', byName.get('storyboard')?.source === 'user' && byName.get('storyboard')?.overrides === 'builtin', JSON.stringify(byName.get('storyboard')))
check('builtin flagged', byName.get('brand-poster')?.source === 'builtin')
check('user-only flagged', byName.get('my-skill')?.source === 'user' && !byName.get('my-skill')?.overrides)

const loadUser = await call('load_skill', { name: 'storyboard' })
check('load_skill returns user version', loadUser.includes('# User storyboard'), loadUser)
const loadBuiltin = await call('load_skill', { name: 'brand-poster' })
check('load_skill returns builtin flat file', loadBuiltin.includes('# Builtin poster'), loadBuiltin)
const loadFolder = await call('load_skill', { name: 'my-skill' })
check('load_skill returns user flat file', loadFolder.includes('# My skill'), loadFolder)
const missing = await call('load_skill', { name: 'nope' })
check('load_skill readable error lists skills', missing.includes('skill not found: nope') && missing.includes('my-skill'), missing)

child.kill()

// ---- real repo skills/: default ED_SKILLS_DIR (repo skills/) must expose the ported workflows ----
const child2 = spawn(process.execPath, [serverPath], {
  env: { ...process.env, ED_PROJECT_DIR: proj, ED_SETTINGS_FILE: '', ED_USER_SKILLS_DIR: '' },
  stdio: ['pipe', 'pipe', 'inherit']
})
child2.stdout.setEncoding('utf-8')
child2.stdout.on('data', (d) => {
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
const rpc2 = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
const call2 = async (tool, args = {}) => {
  const res = await rpc2('tools/call', { name: tool, arguments: args })
  return res.result?.content?.[0]?.text ?? JSON.stringify(res)
}
await rpc2('initialize', { protocolVersion: '2024-11-05' })
const real = JSON.parse(await call2('list_skills'))
const realNames = real.skills.map((s) => s.name)
check('repo exposes 6 skills incl. video-replica & brand-film', realNames.length === 6 && realNames.includes('video-replica') && realNames.includes('brand-film'), JSON.stringify(realNames))
const vd = await call2('load_skill', { name: 'video-replica' })
check('video-replica loads with evidence + provider boundary hint', vd.includes('取证') && vd.includes('entropy_media_montage') && vd.includes('provider-params'), vd.slice(0, 150))
const ba = await call2('load_skill', { name: 'brand-film' })
check('brand-film loads with scope gate + routes', ba.includes('入口与分流') && ba.includes('质感情绪'), ba.slice(0, 150))
child2.kill()

fs.rmSync(proj, { recursive: true, force: true })
console.log(fails.length ? `\n${fails.length} FAIL` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
