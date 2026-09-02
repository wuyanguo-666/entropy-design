// Video generation provider adapters (zero-dependency).
// Each: submit -> poll -> download to <project>/generated/<name>.mp4

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Kling OpenAPI uses HS256 JWT signed with the secret key, iss = access key. */
export function signKlingJwt(accessKey, secretKey, nowMs = Date.now()) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = { iss: accessKey, exp: Math.floor(nowMs / 1000) + 1800, nbf: Math.floor(nowMs / 1000) - 5 }
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = b64url(crypto.createHmac('sha256', secretKey).update(data).digest())
  return `${data}.${sig}`
}

export function slugifyVideo(name) {
  const base = (name || 'video').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${base}-${stamp}.mp4`
}

export async function downloadVideo(url, projectDir, saveName) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`video download ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const fname = slugifyVideo(saveName)
  const rel = path.join('generated', fname)
  const abs = path.join(projectDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
  return rel.split(path.sep).join('/')
}

function readRefImageAsDataUrl(ref) {
  if (/^https?:\/\//.test(ref)) return ref
  const buf = fs.readFileSync(ref)
  const ext = path.extname(ref).toLowerCase()
  const mime = ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function poll(pollFn, { intervalMs = 5000, timeoutMs = 15 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pollFn()
    if (result !== undefined) return result
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('video generation timed out')
}

// ---------- Kling (可灵) ----------

export async function generateKlingVideo(args, cfg, projectDir) {
  const base = (cfg.baseURL || 'https://api.klingai.com').replace(/\/$/, '')
  const token = signKlingJwt(cfg.accessKey, cfg.secretKey)
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const isI2V = !!args.ref_image
  const ep = isI2V ? '/v1/videos/image2video' : '/v1/videos/text2video'

  const body = {
    model_name: args.model || cfg.model || 'kling-v1',
    prompt: args.prompt,
    duration: String(args.duration || 5),
    mode: args.mode || 'std',
    aspect_ratio: args.aspect_ratio || '16:9'
  }
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt
  if (isI2V) body.image = readRefImageAsDataUrl(args.ref_image)
  // 首尾帧：tail frame is only meaningful (and accepted) together with a first frame
  if (args.tail_image) {
    if (!isI2V) throw new Error('可灵使用尾帧时必须同时提供首帧 ref_image（首尾帧模式）')
    body.tail_image_url = readRefImageAsDataUrl(args.tail_image)
  }

  const res = await fetch(`${base}${ep}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const created = await res.json().catch(() => ({}))
  if (!res.ok || !created?.data?.task_id) {
    throw new Error(`kling submit ${res.status}: ${JSON.stringify(created).slice(0, 300)}`)
  }
  const taskId = created.data.task_id

  const url = await poll(async () => {
    const r = await fetch(`${base}${ep}/${taskId}`, { headers })
    const j = await r.json().catch(() => ({}))
    const status = j?.data?.task_status
    if (status === 'succeed') {
      const videos = j?.data?.task_result?.videos || []
      if (!videos.length) throw new Error('kling succeeded but returned no videos')
      return videos[0].url
    }
    if (status === 'failed') throw new Error(`kling failed: ${j?.data?.task_status_msg || 'unknown error'}`)
    return undefined
  })
  return downloadVideo(url, projectDir, args.save_name || 'kling')
}

// ---------- MiniMax 海螺 ----------

export async function generateMiniMaxVideo(args, cfg, projectDir) {
  const base = (cfg.baseURL || 'https://api.minimaxi.com').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }
  const isI2V = !!args.ref_image

  const body = { prompt: args.prompt }
  if (isI2V) {
    // cfg.model may be a shared id usable for both modes (e.g. Hailuo-2.3 series);
    // T2V-only ids reject first_frame_image, so they fall back to the I2V default
    body.model = args.model || (cfg.model && !/^T2V/i.test(cfg.model) ? cfg.model : 'I2V-01')
    body.first_frame_image = readRefImageAsDataUrl(args.ref_image)
  } else {
    body.model = args.model || cfg.model || 'T2V-01'
    // 图生视频的比例由首帧决定；只有文生需要在请求体里指定画幅
    if (args.aspect_ratio) body.aspect_ratio = args.aspect_ratio
  }
  if (args.tail_image) {
    throw new Error('MiniMax 海螺 I2V 暂不支持尾帧。请改用可灵（支持首尾帧），或仅使用首帧。')
  }
  // 海螺 takes an explicit clip length; ignoring it would silently return the vendor default
  if (args.duration) body.duration = Number(args.duration)

  const res = await fetch(`${base}/v1/video_generation`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const created = await res.json().catch(() => ({}))
  if (!res.ok || !created?.task_id) {
    throw new Error(`minimax submit ${res.status}: ${JSON.stringify(created).slice(0, 300)}`)
  }
  const taskId = created.task_id

  const fileId = await poll(async () => {
    const r = await fetch(`${base}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, { headers })
    const j = await r.json().catch(() => ({}))
    if (j?.status === 'Success' && j?.file_id) return j.file_id
    if (j?.status === 'Fail') throw new Error(`minimax failed: ${JSON.stringify(j).slice(0, 300)}`)
    return undefined
  })

  const fRes = await fetch(`${base}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, { headers })
  const fJson = await fRes.json().catch(() => ({}))
  const url = fJson?.file?.download_url
  if (!url) throw new Error(`minimax file retrieve failed: ${JSON.stringify(fJson).slice(0, 300)}`)
  return downloadVideo(url, projectDir, args.save_name || 'minimax')
}

// ---------- fal.ai (queue API) ----------

export async function generateFalVideo(args, cfg, projectDir) {
  const model = args.model || cfg.model || 'fal-ai/kling-video/v1/standard/text-to-video'
  const base = (cfg.baseUrl || 'https://queue.fal.run').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }
  const body = { prompt: args.prompt }
  if (args.aspect_ratio) body.aspect_ratio = args.aspect_ratio
  if (args.duration) body.duration = String(args.duration)
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt
  if (args.ref_image) body.image_url = readRefImageAsDataUrl(args.ref_image)
  if (args.tail_image) body.tail_image_url = readRefImageAsDataUrl(args.tail_image)

  const res = await fetch(`${base}/${model}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const created = await res.json().catch(() => ({}))
  if (!res.ok || !created?.status_url) {
    throw new Error(`fal submit ${res.status}: ${JSON.stringify(created).slice(0, 300)}`)
  }

  await poll(async () => {
    const r = await fetch(created.status_url, { headers })
    const j = await r.json().catch(() => ({}))
    if (j?.status === 'COMPLETED') return true
    if (j?.status === 'FAILED' || j?.error) throw new Error(`fal failed: ${JSON.stringify(j).slice(0, 300)}`)
    return undefined
  })

  const r2 = await fetch(created.response_url, { headers })
  const out = await r2.json().catch(() => ({}))
  const url = out?.video?.url || out?.videos?.[0]?.url || out?.url
  if (!url) throw new Error(`fal response has no video url: ${JSON.stringify(out).slice(0, 300)}`)
  return downloadVideo(url, projectDir, args.save_name || 'fal')
}

/** Resolve "data.task_result.videos[0].url" style paths against a parsed JSON object. */
export function getPath(obj, dotPath) {
  if (!dotPath) return undefined
  const parts = String(dotPath)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let cur = obj
  for (const key of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[key]
  }
  return cur
}

// ---------- Custom task-style API (URL + apiKey, Kling-like submit/poll shape) ----------

export async function generateCustomVideo(args, cfg, projectDir) {
  if (!cfg.submitUrl || !cfg.queryUrl) {
    throw new Error('视频 API 未配置完整：需要提交地址和查询地址（在应用设置中填写）')
  }

  // Aliyun DashScope (阿里云百炼) speaks its own dialect: nested input body,
  // a mandatory async header, SUCCEEDED/FAILED status values and output.* paths.
  const isDashScope = cfg.submitUrl.includes('dashscope.aliyuncs.com')

  const headers = { 'content-type': 'application/json' }
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`

  let body
  let taskIdPath = cfg.taskIdPath || 'data.task_id'
  let statusPath = cfg.statusPath || 'data.task_status'
  let successValue = cfg.successValue || 'succeed'
  let failValue = cfg.failValue || 'failed'
  let videoUrlPath = cfg.videoUrlPath || 'data.task_result.videos[0].url'

  if (isDashScope) {
    headers['X-DashScope-Async'] = 'enable'
    body = { model: args.model || cfg.model, input: { prompt: args.prompt } }
    const parameters = {}
    if (args.duration) parameters.duration = args.duration
    if (args.size) parameters.size = String(args.size).replace('x', '*')
    else if (args.aspect_ratio === '9:16') parameters.size = '720*1280'
    else if (args.aspect_ratio === '1:1') parameters.size = '960*960'
    else if (args.aspect_ratio) parameters.size = '1280*720'
    if (Object.keys(parameters).length) body.parameters = parameters
    // ref_image must be a public URL for DashScope; local files are rejected
    if (args.ref_image) {
      if (!/^https?:\/\//.test(args.ref_image)) {
        throw new Error('阿里云百炼图生视频要求首帧为公网 URL；本地图片请先上传或改用文生视频')
      }
      body.input.img_url = args.ref_image
    }
    taskIdPath = 'output.task_id'
    statusPath = 'output.task_status'
    successValue = 'SUCCEEDED'
    failValue = 'FAILED'
    videoUrlPath = 'output.video_url'
  } else {
    body = { prompt: args.prompt }
    if (cfg.model || args.model) body.model = args.model || cfg.model
    if (args.aspect_ratio) body.aspect_ratio = args.aspect_ratio
    if (args.duration) body.duration = String(args.duration)
    if (args.negative_prompt) body.negative_prompt = args.negative_prompt
    if (args.ref_image) body.image = readRefImageAsDataUrl(args.ref_image)
    if (args.tail_image) body.tail_image = readRefImageAsDataUrl(args.tail_image)
  }

  const res = await fetch(cfg.submitUrl, { method: 'POST', headers, body: JSON.stringify(body) })
  const created = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`submit ${res.status}: ${JSON.stringify(created).slice(0, 300)}`)
  const taskId = getPath(created, taskIdPath)
  if (!taskId) throw new Error(`无法从响应中解析任务 ID（路径 ${taskIdPath}）: ${JSON.stringify(created).slice(0, 300)}`)

  const url = await poll(async () => {
    const r = await fetch(String(cfg.queryUrl).replace('{task_id}', encodeURIComponent(String(taskId))), { headers })
    const j = await r.json().catch(() => ({}))
    const status = getPath(j, statusPath)
    if (status === successValue) {
      const videoUrl = getPath(j, videoUrlPath)
      if (!videoUrl) throw new Error(`任务成功但无法解析视频地址（路径 ${videoUrlPath}）: ${JSON.stringify(j).slice(0, 300)}`)
      return String(videoUrl)
    }
    if (status === failValue) {
      const msg = getPath(j, 'output.message') || getPath(j, 'message') || ''
      throw new Error(`任务失败: ${msg} ${JSON.stringify(j).slice(0, 260)}`)
    }
    return undefined
  })
  return downloadVideo(url, projectDir, args.save_name || cfg.name || 'video')
}

/** Try each adapter against a local mock server to validate request construction. */
export const _internals = { signKlingJwt, poll, readRefImageAsDataUrl, downloadVideo, getPath }
