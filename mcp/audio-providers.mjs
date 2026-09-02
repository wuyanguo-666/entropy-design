// Audio generation adapters: OpenAI-compatible TTS + fal.ai music (queue API).

import * as fs from 'node:fs'
import * as path from 'node:path'

function slugifyAudio(name, ext) {
  const base = (name || 'audio').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${base}-${stamp}.${ext}`
}

function saveAudio(projectDir, buf, name, ext) {
  const fname = slugifyAudio(name, ext)
  const rel = path.join('generated', fname)
  const abs = path.join(projectDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
  return rel.split(path.sep).join('/')
}

/** OpenAI-compatible TTS: POST {base}/audio/speech -> binary audio stream. */
export async function generateOpenAISpeech(args, cfg, projectDir) {
  if (!cfg.apiKey) throw new Error('TTS provider has no apiKey configured')
  const base = (cfg.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const body = {
    model: args.model || cfg.model || 'tts-1',
    input: args.text,
    voice: args.voice || cfg.voice || 'alloy',
    response_format: 'mp3'
  }
  if (args.speed) body.speed = Number(args.speed)
  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`TTS ${res.status}: ${t.slice(0, 300)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 512) throw new Error(`TTS returned suspiciously small payload (${buf.length} bytes)`)
  return saveAudio(projectDir, buf, args.save_name || 'tts', 'mp3')
}

function pickAudioUrl(obj) {
  const candidates = [
    obj?.audio?.url,
    obj?.audio_file?.url,
    obj?.music?.url,
    obj?.audio?.audio_url?.url,
    obj?.url
  ]
  return candidates.find((x) => typeof x === 'string' && x.startsWith('http'))
}

/** fal.ai music: same queue flow as video, audio-shaped response. */
export async function generateFalMusic(args, cfg, projectDir) {
  if (!cfg.apiKey) throw new Error('music provider (fal) has no apiKey configured')
  const model = args.model || cfg.model || 'CassetteAI/music-generator'
  const base = (cfg.baseUrl || 'https://queue.fal.run').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }
  const body = { prompt: args.prompt }
  if (args.duration) body.duration = Number(args.duration)

  const res = await fetch(`${base}/${model}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const created = await res.json().catch(() => ({}))
  if (!res.ok || !created?.status_url) {
    throw new Error(`fal submit ${res.status}: ${JSON.stringify(created).slice(0, 300)}`)
  }

  const deadline = Date.now() + 10 * 60 * 1000
  let done = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const r = await fetch(created.status_url, { headers })
    const j = await r.json().catch(() => ({}))
    if (j?.status === 'COMPLETED') {
      done = true
      break
    }
    if (j?.status === 'FAILED' || j?.error) throw new Error(`fal failed: ${JSON.stringify(j).slice(0, 300)}`)
  }
  if (!done) throw new Error('fal music generation timed out')

  const r2 = await fetch(created.response_url, { headers })
  const out = await r2.json().catch(() => ({}))
  const url = pickAudioUrl(out)
  if (!url) throw new Error(`fal response has no audio url: ${JSON.stringify(out).slice(0, 300)}`)
  const dl = await fetch(url)
  if (!dl.ok) throw new Error(`audio download ${dl.status}`)
  const buf = Buffer.from(await dl.arrayBuffer())
  return saveAudio(projectDir, buf, args.save_name || 'music', 'mp3')
}
