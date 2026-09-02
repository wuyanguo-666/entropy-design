// Entropy Design ComfyUI engine: workflow discovery, parameter schema inspection,
// parameter injection, queueing and output collection. Shared by image_generate
// (comfyui provider) and the comfy_* MCP tools.
//
// Workflow JSON is the ComfyUI API format: { "<nodeId>": { class_type, _meta:{title}, inputs } }.

import * as fs from 'node:fs'
import * as path from 'node:path'

export const COMFY_NOT_CONNECTED = (url) =>
  `ComfyUI 未连接（${url}）。请先启动本地 ComfyUI，并在 设置 → 本地 ComfyUI 中填写地址后重试。`

export const BUILTIN_WORKFLOW = {
  // API-format txt2img workflow (SD1.5/SDXL compatible). Node titled "Prompt" gets the prompt text.
  3: {
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
    inputs: {
      seed: 0,
      steps: 24,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0]
    }
  },
  4: {
    class_type: 'CheckpointLoaderSimple',
    _meta: { title: 'Load Checkpoint' },
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' }
  },
  5: {
    class_type: 'EmptyLatentImage',
    _meta: { title: 'Empty Latent Image' },
    inputs: { width: 1024, height: 1024, batch_size: 1 }
  },
  6: {
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Prompt' },
    inputs: { text: '', clip: ['4', 1] }
  },
  7: {
    class_type: 'CLIPTextEncode',
    _meta: { title: 'Negative Prompt' },
    inputs: { text: 'low quality, blurry, watermark', clip: ['4', 1] }
  },
  8: { class_type: 'VAEDecode', _meta: { title: 'VAE Decode' }, inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', _meta: { title: 'Save Image' }, inputs: { filename_prefix: 'entropy', images: ['8', 0] } }
}

// img2img twin: same graph but the latent comes from VAE-encoding an uploaded reference
// image (LoadImage node 10); denoise 0.65 keeps composition while allowing restyle.
export const BUILTIN_IMG2IMG_WORKFLOW = {
  ...JSON.parse(JSON.stringify(BUILTIN_WORKFLOW)),
  3: {
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
    inputs: {
      seed: 0,
      steps: 24,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 0.65,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['2', 0]
    }
  },
  1: {
    class_type: 'LoadImage',
    _meta: { title: 'Load Image' },
    inputs: { image: 'example.png' }
  },
  2: {
    class_type: 'VAEEncode',
    _meta: { title: 'VAE Encode' },
    inputs: { pixels: ['1', 0], vae: ['4', 2] }
  }
}
// txt2img's Empty Latent Image node is unused in the img2img graph
delete BUILTIN_IMG2IMG_WORKFLOW[5]

/** Enumerate workflows: the built-in templates plus *.json from settings workflowPath (file or dir). */
export function listWorkflows(cfg) {
  const out = [
    { name: 'builtin-txt2img', source: 'builtin', path: '', description: '内置 SD1.5/SDXL 文生图模板（Prompt / Negative Prompt / Empty Latent Image / KSampler 按 title 注入）' },
    { name: 'builtin-img2img', source: 'builtin', path: '', description: '内置图生图模板（Load Image 注入参考图，KSampler denoise 0.65 可经 params 调整）' }
  ]
  const wp = cfg?.workflowPath
  if (wp && fs.existsSync(wp)) {
    if (fs.statSync(wp).isFile() && wp.endsWith('.json')) {
      out.push({ name: path.basename(wp, '.json'), source: 'file', path: wp })
    } else if (fs.statSync(wp).isDirectory()) {
      for (const f of fs.readdirSync(wp).filter((x) => x.endsWith('.json'))) {
        out.push({ name: path.basename(f, '.json'), source: 'file', path: path.join(wp, f) })
      }
    }
  }
  return out
}

/** Deep-copy a workflow by name (builtin or file). Throws when unknown. */
export function loadWorkflow(cfg, name) {
  if (!name || name === 'builtin-txt2img') {
    return JSON.parse(JSON.stringify(BUILTIN_WORKFLOW))
  }
  if (name === 'builtin-img2img') {
    return JSON.parse(JSON.stringify(BUILTIN_IMG2IMG_WORKFLOW))
  }
  const wf = listWorkflows(cfg).find((w) => w.source === 'file' && w.name === name)
  if (!wf) {
    const names = listWorkflows(cfg).map((w) => w.name).join(', ')
    throw new Error(`workflow not found: ${name}. Available: ${names}`)
  }
  return JSON.parse(fs.readFileSync(wf.path, 'utf-8'))
}

async function comfyFetch(url, rel, init, timeoutMs = 15000) {
  const res = await fetch(`${url}${rel}`, { signal: AbortSignal.timeout(timeoutMs), ...init })
  if (!res.ok) throw new Error(`ComfyUI ${rel} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
  return res.json()
}

/** Fetch /object_info once for input schema discovery. */
export async function fetchObjectInfo(url) {
  try {
    return await comfyFetch(url, '/object_info', {})
  } catch {
    throw new Error(COMFY_NOT_CONNECTED(url))
  }
}

/** Upload a local image into ComfyUI's input dir; returns the stored name for LoadImage. */
export async function uploadComfyImage(base, absPath) {
  const buf = fs.readFileSync(absPath)
  const form = new FormData()
  form.append('image', new Blob([buf]), path.basename(absPath))
  form.append('type', 'input')
  let res
  try {
    res = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  } catch {
    throw new Error(COMFY_NOT_CONNECTED(base))
  }
  if (!res.ok) throw new Error(`ComfyUI /upload/image ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const j = await res.json()
  if (!j?.name) throw new Error('ComfyUI /upload/image returned no name')
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

/**
 * Describe a workflow's editable parameters: for each node, the widget-style inputs
 * (text/number/bool/choice) with current values and — when /object_info knows them — choices.
 */
export function describeWorkflow(workflow, objectInfo) {
  const nodes = []
  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !node.class_type) continue
    const info = objectInfo?.[node.class_type]?.input || {}
    const spec = { required: info.required || {}, optional: info.optional || {} }
    const inputs = []
    for (const [key, value] of Object.entries(node.inputs || {})) {
      // links ([nodeId, slot]) are graph wiring, not editable widgets
      if (Array.isArray(value)) continue
      const decl = spec.required[key] || spec.optional[key]
      let type = Array.isArray(value) ? 'array' : typeof value
      let options
      if (Array.isArray(decl?.[0]) && decl[0].every((x) => typeof x === 'string' || typeof x === 'number')) {
        type = 'choice'
        options = decl[0]
      } else if (decl?.[0] === 'INT' || decl?.[0] === 'FLOAT') {
        type = decl[0].toLowerCase()
      } else if (decl?.[0] === 'STRING' || decl?.[0] === 'BOOLEAN') {
        type = String(decl[0]).toLowerCase()
      }
      inputs.push({ key, type, current: value, options })
    }
    nodes.push({ id, title: node._meta?.title || node.class_type, class_type: node.class_type, inputs })
  }
  return nodes
}

/**
 * Inject parameters keyed by node title: params = { "<node title>": { "<input key>": value } }.
 * Unmatched titles are reported instead of silently dropped.
 */
export function injectParams(workflow, params = {}) {
  const applied = []
  const unmatched = []
  for (const [title, patch] of Object.entries(params || {})) {
    const node = Object.values(workflow).find((n) => n?._meta?.title === title)
    if (!node || typeof patch !== 'object' || patch === null) {
      unmatched.push(title)
      continue
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in node.inputs)) {
        unmatched.push(`${title}.${k}`)
        continue
      }
      node.inputs[k] = v
      applied.push(`${title}.${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : v}`)
    }
  }
  return { applied, unmatched }
}

/** Randomize every seed-like input so count>1 runs produce distinct results. */
export function randomizeSeeds(workflow) {
  for (const node of Object.values(workflow)) {
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if ((k === 'seed' || k === 'noise_seed') && typeof v === 'number') {
        node.inputs[k] = Math.floor(Math.random() * 2 ** 31)
      }
    }
  }
}

/** First execution_error detail from a ComfyUI history entry, for a readable failure message. */
function comfyErrorMessage(entry) {
  const messages = entry?.status?.messages || []
  for (const [type, detail] of messages) {
    if (type !== 'execution_error' || !detail) continue
    return [detail.node_type, detail.exception_message].filter(Boolean).join(': ')
  }
  return ''
}

/** Queue one workflow run and poll until it finishes. Returns SaveImage outputs. */
export async function runComfyOnce(url, workflow, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const { prompt_id: promptId } = await comfyFetch(url, '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow })
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const history = await comfyFetch(url, `/history/${promptId}`, {}, 30000)
    const entry = history[promptId]
    if (!entry) continue
    // a failed run typically produces no outputs at all — report the error now, not after the timeout
    if (entry.status?.status_str === 'error') {
      const msg = comfyErrorMessage(entry)
      throw new Error(`ComfyUI run failed${msg ? `: ${msg}` : ' (see ComfyUI console)'}`)
    }
    if (entry.outputs && Object.keys(entry.outputs).length > 0) return entry.outputs
  }
  throw new Error('ComfyUI generation timed out')
}

/** Collect downloadable image entries ({filename, subfolder, type}) from run outputs. */
export function collectImages(outputs) {
  const out = []
  for (const nodeOutput of Object.values(outputs)) {
    for (const img of nodeOutput.images || []) out.push(img)
  }
  return out
}

export async function downloadComfyImage(url, img, destAbs) {
  const viewUrl = `${url}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`
  const res = await fetch(viewUrl)
  if (!res.ok) throw new Error(`ComfyUI /view ${res.status}`)
  fs.mkdirSync(path.dirname(destAbs), { recursive: true })
  fs.writeFileSync(destAbs, Buffer.from(await res.arrayBuffer()))
}

/**
 * Full run: resolve workflow (builtin checkpoint auto-pick), upload + inject the
 * reference image for img2img, inject params, run `count` times with fresh seeds,
 * download images. Returns relative paths.
 */
export async function runComfyWorkflow(cfg, { name, params, count = 1, size, prompt, negative_prompt, image_path, saveName, projectDir, url }) {
  const base = (url || cfg?.url || 'http://127.0.0.1:8188').replace(/\/$/, '')
  let workflow = loadWorkflow(cfg, name)
  if (!name || name.startsWith('builtin-')) {
    // pick an available checkpoint when the built-in default is missing
    try {
      const info = await comfyFetch(base, '/object_info/CheckpointLoaderSimple', {}, 15000)
      const list = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []
      const ckptNode = Object.values(workflow).find((n) => n?.class_type === 'CheckpointLoaderSimple')
      if (ckptNode && list.length && !list.includes(ckptNode.inputs.ckpt_name)) ckptNode.inputs.ckpt_name = list[0]
    } catch {
      /* offline pick fails → keep default; the run itself will surface a readable error */
    }
  }
  if (image_path) {
    const loadNode = Object.values(workflow).find((n) => n?.class_type === 'LoadImage')
    if (!loadNode) throw new Error(`工作流 "${name || 'builtin-txt2img'}" 没有 LoadImage 节点，无法注入参考图（图生图请用 builtin-img2img）`)
    if (!fs.existsSync(image_path)) throw new Error(`参考图不存在：${image_path}`)
    loadNode.inputs.image = await uploadComfyImage(base, image_path)
  }
  if (typeof prompt === 'string') (params = { ...params, Prompt: { ...(params?.Prompt || {}), text: prompt } })
  if (typeof negative_prompt === 'string' && negative_prompt) {
    params = { ...params, 'Negative Prompt': { ...(params?.['Negative Prompt'] || {}), text: negative_prompt } }
  }
  if (size && /^(\d+)x(\d+)$/.exec(size)) {
    const [, w, h] = /^(\d+)x(\d+)$/.exec(size)
    params = { ...params, 'Empty Latent Image': { ...(params?.['Empty Latent Image'] || {}), width: Number(w), height: Number(h) } }
  }
  const { applied, unmatched } = injectParams(workflow, params)

  const saved = []
  for (let i = 0; i < Math.min(Math.max(count, 1), 10); i++) {
    randomizeSeeds(workflow)
    const outputs = await runComfyOnce(base, workflow)
    const images = collectImages(outputs)
    if (images.length === 0) throw new Error('ComfyUI returned no images')
    for (const img of images) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const rel = path.join('generated', `${saveName || name || 'comfy'}-${stamp}-${i}-${saved.length}.png`).split(path.sep).join('/')
      await downloadComfyImage(base, img, path.join(projectDir, rel))
      saved.push(rel)
    }
  }
  return { saved, applied, unmatched }
}
