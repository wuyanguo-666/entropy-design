// Media-understanding + image-to-image smoke test.
// Spawns the mock OpenAI-compatible LLM (tools/mock-llm.mjs) as the vision AND image
// endpoint, then exercises media_analyse (image node / path / errors / save_note /
// video frames) and image_generate ref_node_ids lineage through the MCP stdio server.
// The video case skips gracefully when ffmpeg is unavailable.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-analyse-'))
const settingsFile = path.join(proj, 'settings.json')
const mockSettings = {
  media: process.env.ED_TEST_FFMPEG_DIR ? { ffmpegPath: process.env.ED_TEST_FFMPEG_DIR } : undefined,
  vision: { enabled: true, baseURL: 'http://127.0.0.1:4598/v1', apiKey: 'mock', model: 'mock-model' },
  image: { openai: { enabled: true, baseURL: 'http://127.0.0.1:4598/v1', apiKey: 'mock', model: 'mock-model', size: '1024x1024' }, comfyui: { enabled: false, url: '', workflowPath: '' } }
}
fs.writeFileSync(settingsFile, JSON.stringify(mockSettings))

// ---- mock LLM (vision + images endpoint) ----
const mock = spawn(process.execPath, [path.resolve('tools/mock-llm.mjs')], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
async function waitForMock(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:4598/models')
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}
if (!(await waitForMock())) {
  console.log('FAIL  mock-llm did not start on :4598')
  mock.kill()
  process.exit(1)
}

// ---- MCP server ----
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
function cleanup() {
  child.kill()
  mock.kill()
  fs.rmSync(proj, { recursive: true, force: true })
}

await rpc('initialize', { protocolVersion: '2024-11-05' })
const list = await rpc('tools/list', {})
const names = list.result.tools.map((t) => t.name)
check('tools/list has media_analyse', names.includes('media_analyse'))

// ---- fabricate a tiny PNG and import it as a canvas image node ----
const pngAbs = path.join(proj, 'ref.png')
fs.writeFileSync(
  pngAbs,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
)
const importRes = await call('canvas_node_add_file', { source_path: pngAbs, name: 'ref' })
const imgNodeId = (/id=([0-9a-f-]+)/.exec(importRes) || [])[1]
check('reference image imported to canvas', importRes.startsWith('image node created') && !!imgNodeId, importRes.slice(0, 120))

// ---- media_analyse: happy paths ----
const byNode = JSON.parse(await call('media_analyse', { node_id: imgNodeId }))
check('media_analyse by node_id describes image', byNode.status === 'ok' && byNode.kind === 'image' && byNode.description.includes('mock 视觉描述'), JSON.stringify(byNode).slice(0, 200))
const byPath = JSON.parse(await call('media_analyse', { path: 'ref.png', question: '有什么文字？' }))
check('media_analyse by relative path + question', byPath.status === 'ok' && byPath.frames === 1, JSON.stringify(byPath).slice(0, 200))
const noted = JSON.parse(await call('media_analyse', { node_id: imgNodeId, save_note: true }))
const docAfterNote = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const noteNode = docAfterNote.nodes.find((n) => n.id === noted.note_node_id)
check('save_note writes analysis text node with lineage', !!noteNode && noteNode.type === 'text' && noteNode.data.text.includes('mock 视觉描述') && docAfterNote.edges.some((e) => e.source === imgNodeId && e.target === noteNode.id), JSON.stringify(noted).slice(0, 200))

// ---- media_analyse: error paths ----
check('media_analyse without target errors clearly', (await call('media_analyse', {})).includes('provide either'))
check('media_analyse unknown node errors clearly', (await call('media_analyse', { node_id: 'no-such-node' })).includes('canvas node not found'))
const txtAbs = path.join(proj, 'note.txt')
fs.writeFileSync(txtAbs, 'hello')
check('media_analyse rejects unsupported type', (await call('media_analyse', { path: 'note.txt' })).includes('unsupported media type'))

// ---- media_analyse: graceful error when vision not configured ----
fs.writeFileSync(settingsFile, JSON.stringify({ ...mockSettings, vision: { ...mockSettings.vision, enabled: false } }))
check('media_analyse fails readable when vision disabled', (await call('media_analyse', { path: 'ref.png' })).includes('媒体理解未配置'))
fs.writeFileSync(settingsFile, JSON.stringify(mockSettings))

// ---- image-to-image via ref_node_ids (mock /images/edits) ----
const i2i = JSON.parse(await call('image_generate', { prompt: '把参考图改成夜景', ref_node_ids: [imgNodeId], save_name: 'i2i' }))
check('image_generate ref_node_ids returns image', i2i.status === 'ok' && i2i.provider === 'openai' && i2i.images?.length === 1, JSON.stringify(i2i).slice(0, 200))
const docI2i = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const i2iNode = docI2i.nodes.find((n) => n.id === i2i.images?.[0]?.node_id)
check('i2i node auto-linked to reference node', i2iNode?.data?.sourceNodeId === imgNodeId && docI2i.edges.some((e) => e.source === imgNodeId && e.target === i2iNode.id), JSON.stringify(i2iNode?.data).slice(0, 200))
check('image_generate unknown ref node errors clearly', (await call('image_generate', { prompt: 'x', ref_node_ids: ['ghost'] })).includes('ref node not found'))

// ---- comfy builtin img2img is discoverable ----
const wfList = JSON.parse(await call('comfy_list_workflows'))
check('comfy_list_workflows shows builtin-img2img', Array.isArray(wfList.workflows) && wfList.workflows.some((w) => w.name === 'builtin-img2img'), JSON.stringify(wfList.workflows.map((w) => w.name)))

// ---- identity-locked series (series_count: base + i2i variations anchored on base) ----
const series = JSON.parse(await call('image_generate', { prompt: '奇幻角色正面', variation_prompt: '同一角色，换侧面视角，光照不变', series_count: 3, save_name: 'char' }))
check('series returns base + 2 variations', series.status === 'ok' && !!series.base?.node_id && series.variations?.length === 2, JSON.stringify(series).slice(0, 250))
const docSeries = JSON.parse(fs.readFileSync(path.join(proj, '.entropy/canvas.json'), 'utf-8'))
const vNodes = series.variations.map((v) => docSeries.nodes.find((n) => n.id === v.node_id))
check('variation nodes lineage-link to base', vNodes.every((n) => n && n.data.sourceNodeId === series.base.node_id), JSON.stringify(vNodes.map((n) => n?.data?.sourceNodeId)))
check('canvas has base→variation edges', series.variations.every((v) => docSeries.edges.some((e) => e.source === series.base.node_id && e.target === v.node_id)), JSON.stringify(docSeries.edges.map((e) => `${e.source.slice(0, 4)}->${e.target.slice(0, 4)}`)))
check('variation files named -vNN', series.variations.every((v, i) => v.file.includes(`-v${String(i + 2).padStart(2, '0')}`)), JSON.stringify(series.variations.map((v) => v.file)))
const series1 = JSON.parse(await call('image_generate', { prompt: '单图', n: 2 }))
check('series_count absent keeps legacy n behavior', series1.status === 'ok' && Array.isArray(series1.images) && !series1.base, JSON.stringify(series1).slice(0, 150))

// ---- video analysis (needs ffmpeg; skip gracefully) ----
const ffmpegBin = process.env.ED_TEST_FFMPEG_DIR ? path.join(process.env.ED_TEST_FFMPEG_DIR, 'ffmpeg.exe') : 'ffmpeg'
const madeClip = await new Promise((resolve) => {
  const c = spawn(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15', '-pix_fmt', 'yuv420p', path.join(proj, 'clip.mp4')], { stdio: 'ignore', windowsHide: true })
  c.on('error', () => resolve(false))
  c.on('close', (code) => resolve(code === 0))
})
if (!madeClip) {
  console.log('SKIP  ffmpeg unavailable — video frame sampling not exercised')
} else {
  const vid = JSON.parse(await call('media_analyse', { path: 'clip.mp4', frames: 3 }))
  check('media_analyse samples video frames', vid.status === 'ok' && vid.kind === 'video' && vid.frames >= 2 && vid.frames <= 3 && vid.description.includes('mock 视觉描述'), JSON.stringify(vid).slice(0, 250))
}

cleanup()
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`)
process.exit(fails.length === 0 ? 0 : 1)
