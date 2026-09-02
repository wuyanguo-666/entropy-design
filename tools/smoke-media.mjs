// Media tools smoke test: uses the local ffmpeg to fabricate tiny test videos, then
// exercises media_probe / videos_merge / trim_video / subtitle_burn / extract_audio
// through the MCP stdio server. Skips gracefully when ffmpeg is unavailable.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-media-'))
// point media.ffmpegPath at a directory (exercises the settings resolution path):
// explicit ED_TEST_FFMPEG_DIR wins, else the staged vendor/ffmpeg/current if present
const exe = process.platform === 'win32' ? '.exe' : ''
const staged = path.resolve('vendor', 'ffmpeg', 'current')
const ffdir = process.env.ED_TEST_FFMPEG_DIR || (fs.existsSync(path.join(staged, 'ffmpeg' + exe)) ? staged : '')
let settingsFile = ''
if (ffdir) {
  settingsFile = path.join(proj, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ media: { ffmpegPath: ffdir } }))
}
const serverPath = path.resolve('mcp/server.mjs')
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, ED_PROJECT_DIR: proj, ED_SETTINGS_FILE: settingsFile },
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

// fabricate two 1s test clips (video+tone) with the system ffmpeg; SKIP everything without it
function run(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    c.stderr.on('data', (d) => (err += d))
    c.on('error', () => resolve(127))
    c.on('close', (code) => resolve(code === 0 ? 0 : (console.error(err.slice(-400)), code)))
  })
}

const clip = (n, color) =>
  run(ffdir ? path.join(ffdir, 'ffmpeg' + exe) : 'ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=1:r=25`,
    '-f', 'lavfi', '-i', `sine=frequency=${n === 1 ? 440 : 660}:duration=1`,
    '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'aac', '-shortest', path.join(proj, `clip${n}.mp4`)
  ])

const gen = await Promise.all([clip(1, 'red'), clip(2, 'blue')])
if (gen.some((c) => c !== 0)) {
  console.log('SKIP  ffmpeg unavailable or test clip generation failed — media tools not exercised')
  child.kill()
  fs.rmSync(proj, { recursive: true, force: true })
  process.exit(0)
}

const probe1 = JSON.parse(await call('media_probe', { path: path.join(proj, 'clip1.mp4') }))
check('media_probe reads duration/codec', probe1.status === 'ok' && Math.abs(probe1.duration_seconds - 1) < 0.3 && probe1.video_codec === 'mpeg4' && probe1.has_audio === true, JSON.stringify(probe1))

const merged = JSON.parse(await call('videos_merge', { paths: [path.join(proj, 'clip1.mp4'), path.join(proj, 'clip2.mp4')], output_name: 'merged' }))
check('videos_merge ~2s', merged.status === 'ok' && Math.abs(merged.duration_seconds - 2) < 0.5, JSON.stringify(merged).slice(0, 300))

const trimmed = JSON.parse(await call('trim_video', { path: merged.video.file, start: 0.2, end: 0.8, output_name: 'trimmed' }))
check('trim_video ~0.6s', trimmed.status === 'ok' && trimmed.duration_seconds < 0.9, JSON.stringify(trimmed).slice(0, 300))

const srt = path.join(proj, 'subs.srt')
fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\n测试字幕 hello\n')
const burned = JSON.parse(await call('subtitle_burn', { video: merged.video.file, subtitle: srt, style: 'FontSize=16', output_name: 'burned' }))
check('subtitle_burn produces video', burned.status === 'ok' && Math.abs(burned.duration_seconds - 2) < 0.5, JSON.stringify(burned).slice(0, 300))

const audio = JSON.parse(await call('extract_audio', { video: merged.video.file, output_name: 'bgm' }))
check('extract_audio makes mp3', audio.status === 'ok' && audio.audio.file.endsWith('.mp3'), JSON.stringify(audio))

const montage = JSON.parse(await call('media_montage', { video: merged.video.file, per_sheet: 12, max_sheets: 2, output_name: 'sheet' }))
const montageFiles = (montage.sheets || []).map((s) => s.file)
check('media_montage builds contact sheets', montage.status === 'ok' && montage.sheets.length >= 1 && montageFiles.every((f) => f.startsWith('generated/') && f.endsWith('.png') && fs.existsSync(path.join(proj, f))), JSON.stringify(montage).slice(0, 300))
const montageDoc = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
check('montage sheets registered as image nodes', montage.sheets.every((s) => montageDoc.nodes.some((n) => n.id === s.node_id && n.type === 'image' && n.data?.montageOf)))

// canvas registration: each tool should have added a node
const list = JSON.parse(await call('canvas_nodes_list'))
const mediaNodes = list.nodes.filter((n) => ['video', 'audio'].includes(n.type))
check('outputs registered on canvas', mediaNodes.length >= 4, JSON.stringify(mediaNodes.map((n) => n.type)))

// missing-file errors stay readable
const miss = await call('videos_merge', { paths: [path.join(proj, 'clip1.mp4'), path.join(proj, 'nope.mp4')] })
check('merge missing input errors clearly', miss.includes('file not found'), miss.slice(0, 120))

child.kill()
fs.rmSync(proj, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
