// Entropy Design media-understanding tool: describe an image or video by sending it
// (and, for video, sampled frames) to a configured OpenAI-compatible vision model.
// Zero-dependency; reuses the ffmpeg line from media-tools for frame extraction.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { resolveMediaBins } from './media-tools.mjs'

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VID_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase()
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
}

function dataUrl(absPath) {
  const buf = fs.readFileSync(absPath)
  return `data:${mimeOf(absPath)};base64,${buf.toString('base64')}`
}

/** Probe duration (seconds) of a media file via ffprobe; returns 0 when unknown. */
function probeDuration(ffprobe, videoAbs) {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(ffprobe, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoAbs], { windowsHide: true })
    child.stdout?.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => {
      child.kill()
      resolve(0)
    }, 15_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const n = Number(out.trim())
      resolve(Number.isFinite(n) && n > 0 ? n : 0)
    })
  })
}

/** Extract up to `maxFrames` evenly-spaced JPEG frames from a video into a temp dir. */
async function extractFrames(bins, videoAbs, maxFrames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-analyse-'))
  const out = path.join(dir, 'f-%03d.jpg')
  // fps chosen so the clip yields ~maxFrames samples regardless of its length; -vf scale keeps payloads small for the API
  const dur = await probeDuration(bins.ffprobe, videoAbs)
  const fps = dur > 0 ? Math.max(0.1, maxFrames / dur) : 1
  await new Promise((resolve, reject) => {
    const child = spawn(bins.ffmpeg, ['-y', '-i', videoAbs, '-vf', `fps=${fps.toFixed(3)},scale=512:-2`, '-frames:v', String(maxFrames), out], { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => (err += d.toString()))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('ffmpeg frame extraction timed out'))
    }, 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`ffmpeg frame extraction failed: ${err.slice(-300)}`))
      else resolve()
    })
  })
  const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f))
  return { dir, frames }
}

async function callVision(cfg, imageUrls, prompt) {
  const base = (cfg.baseURL || '').replace(/\/$/, '')
  const content = [{ type: 'text', text: prompt }, ...imageUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content }],
      stream: false
    }),
    signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`vision API ${res.status}: ${t.slice(0, 400)}`)
  }
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('vision model returned no text')
  return text.trim()
}

export function createAnalyseTools({ readCanvas, addNode, addEdgeToDoc, nextNodePos, toText, toError, PROJECT_DIR, loadSettings }) {
  function resolveTarget(args) {
    let abs = null
    let label = ''
    if (args.node_id) {
      const doc = readCanvas()
      const node = (doc.nodes || []).find((n) => n.id === args.node_id)
      if (!node) return { error: `canvas node not found: ${args.node_id}` }
      if (!node.data?.path) return { error: `node ${args.node_id} has no media file attached (it is not an image/video node)` }
      abs = path.isAbsolute(node.data.path) ? node.data.path : path.join(PROJECT_DIR, node.data.path)
      label = node.data.name || path.basename(abs)
    } else if (args.path) {
      abs = path.isAbsolute(args.path) ? args.path : path.join(PROJECT_DIR, args.path)
      label = path.basename(abs)
    } else {
      return { error: 'provide either node_id (a canvas image/video node) or path (a media file)' }
    }
    if (!fs.existsSync(abs)) return { error: `file not found: ${label}` }
    const ext = path.extname(abs).toLowerCase()
    const kind = IMG_EXT.has(ext) ? 'image' : VID_EXT.has(ext) ? 'video' : null
    if (!kind) return { error: `unsupported media type "${ext || '?'}" — pass an image (${[...IMG_EXT].join(' ')}) or video (${[...VID_EXT].join(' ')}) file` }
    return { abs, label, kind }
  }

  return {
    media_analyse: {
      description:
        'Understand an existing image or video by sending it to the configured vision model (设置 → 媒体理解). ' +
        'Returns a natural-language description of the frame(s) — subject, composition, style, motion — so you can ' +
        'judge whether a generated asset matches intent, extract a reference image\'s style, or answer questions about a file. ' +
        'Pass node_id (a canvas image/video node) or path. For video it samples up to `frames` key frames (default 4). ' +
        'Optionally pass `question` to steer the analysis (e.g. "画面里有什么文字？" or "构图是否居中").',
      inputSchema: {
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'Canvas node id of an image/video to analyse' },
          path: { type: 'string', description: 'Absolute or project-relative media file path' },
          question: { type: 'string', description: 'Optional focus for the description' },
          frames: { type: 'number', description: 'Video frames to sample, 1-8 (default 4)' },
          save_note: { type: 'boolean', description: 'Also write the description as a canvas text node (default false)' }
        },
        additionalProperties: false
      },
      async run(args) {
        const s = loadSettings()
        const cfg = s.vision
        if (!cfg?.enabled || !cfg?.apiKey || !cfg?.baseURL) {
          return toError('媒体理解未配置。请让用户在 设置 → 媒体理解 中启用视觉模型并填写 baseURL / API Key / model。')
        }
        const target = resolveTarget(args)
        if (target.error) return toError(target.error)

        let cleanupDir = null
        try {
          let imageUrls
          let prompt
          if (target.kind === 'image') {
            imageUrls = [dataUrl(target.abs)]
            prompt =
              `请详细描述这张图片：主体、构图、配色、风格、光影、画面中的任何文字，以及整体氛围。` +
              (args.question ? `\n\n另外请重点回答：${args.question}` : '')
          } else {
            const bins = resolveMediaBins(loadSettings)
            if (!bins.ffmpeg) return toError(bins.reason || 'ffmpeg not found — video frame extraction needs it')
            const maxFrames = Math.min(Math.max(Number(args.frames) || 4, 1), 8)
            const { dir, frames } = await extractFrames(bins, target.abs, maxFrames)
            cleanupDir = dir
            if (frames.length === 0) return toError('could not extract any frames from the video')
            imageUrls = frames.map(dataUrl)
            prompt =
              `这是一段视频的 ${frames.length} 个采样关键帧（按时间顺序）。请综合描述画面内容、主体、风格、运镜与可能的叙事，` +
              `并指出帧之间的变化。` +
              (args.question ? `\n\n另外请重点回答：${args.question}` : '')
          }
          const text = await callVision(cfg, imageUrls, prompt)

          let node_id = null
          if (args.save_note) {
            const doc = readCanvas()
            const pos = nextNodePos(doc)
            const node = {
              id: crypto.randomUUID(),
              type: 'text',
              positions: { main: pos },
              data: {
                name: `分析：${target.label}`,
                text,
                provider: 'vision',
                analysedFrom: target.label,
                sourceNodeId: args.node_id || undefined
              }
            }
            addEdgeToDoc(doc, args.node_id, node.id)
            addNode(doc, node)
            node_id = node.id
          }
          return toText(
            JSON.stringify(
              { status: 'ok', kind: target.kind, file: target.label, frames: imageUrls.length, description: text, note_node_id: node_id },
              null,
              2
            )
          )
        } catch (e) {
          return toError(String(e?.message || e))
        } finally {
          if (cleanupDir) {
            try {
              fs.rmSync(cleanupDir, { recursive: true, force: true })
            } catch {
              /* temp cleanup is best-effort */
            }
          }
        }
      }
    }
  }
}
