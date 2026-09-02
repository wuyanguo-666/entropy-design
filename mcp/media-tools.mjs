// Entropy Design media postprocess tools (ffmpeg/ffprobe line).
// Zero-dependency: binaries are spawned with an args array (no shell), outputs always
// land in <project>/generated/ and are auto-registered on the canvas with lineage.
//
// ffmpeg resolution order: settings.media.ffmpegPath (exe file or directory)
// → bundled with the app (ED_FFMPEG_DIR) → PATH.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const FFMPEG_HINT =
  'ffmpeg 未找到。请安装 ffmpeg 并加入 PATH，或在 设置 → 常规 → FFmpeg 路径 中填入 ffmpeg.exe 的完整路径（或其所在目录）。'

export function resolveMediaBins(loadSettings) {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const check = (dir, name) => {
    const p = path.join(dir, name + exe)
    return fs.existsSync(p) ? p : null
  }
  // 1) explicit setting (exe file or a directory containing the binaries)
  const cfg = loadSettings()?.media?.ffmpegPath
  if (cfg && cfg.trim()) {
    const c = cfg.trim()
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const dir = path.dirname(c)
      return { ffmpeg: c, ffprobe: check(dir, 'ffprobe') }
    }
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      const ffmpeg = check(c, 'ffmpeg')
      if (ffmpeg) return { ffmpeg, ffprobe: check(c, 'ffprobe') }
    }
  }
  // 2) bundled with the app (injected by the Electron main process)
  const bundled = process.env.ED_FFMPEG_DIR
  if (bundled) {
    const ffmpeg = check(bundled, 'ffmpeg')
    if (ffmpeg) return { ffmpeg, ffprobe: check(bundled, 'ffprobe') }
  }
  // 3) PATH scan
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const ffmpeg = check(dir, 'ffmpeg')
    if (ffmpeg) return { ffmpeg, ffprobe: check(dir, 'ffprobe') }
  }
  return { ffmpeg: null, ffprobe: null, reason: FFMPEG_HINT }
}

/** Run a binary collecting stdout/stderr; rejects with a readable message on spawn failure/timeout. */
function runBin(bin, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const child = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? FFMPEG_HINT : `${bin} spawn error: ${String(e)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err: err.slice(-4000) })
    })
  })
}

/** Summarize an ffprobe JSON report into the fields the agent actually needs. */
function summarizeProbe(report) {
  const v = (report.streams || []).find((s) => s.codec_type === 'video')
  const a = (report.streams || []).find((s) => s.codec_type === 'audio')
  return {
    duration_seconds: report.format?.duration ? Math.round(Number(report.format.duration) * 100) / 100 : undefined,
    size_bytes: report.format?.size ? Number(report.format.size) : undefined,
    width: v?.width,
    height: v?.height,
    fps: v?.avg_frame_rate && v.avg_frame_rate.includes('/') ? Math.round((Number(v.avg_frame_rate.split('/')[0]) / Number(v.avg_frame_rate.split('/')[1] || 1)) * 100) / 100 : undefined,
    video_codec: v?.codec_name,
    pix_fmt: v?.pix_fmt,
    has_audio: !!a,
    audio_codec: a?.codec_name,
    sample_rate: a?.sample_rate ? Number(a.sample_rate) : undefined
  }
}

export function createMediaTools(h) {
  const { readCanvas, addNode, addEdgeToDoc, nextNodePos, slugify, toText, toError, PROJECT_DIR, loadSettings } = h

  function outPath(outputName, ext) {
    const rel = path.join('generated', slugify(`${outputName || 'media'}${ext}`))
    const abs = path.join(PROJECT_DIR, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    return { rel: rel.split(path.sep).join('/'), abs }
  }

  /** Register one produced file on the canvas with lineage. */
  function addMediaNode(relPath, type, name, args, extraData) {
    const doc = readCanvas()
    const pos = nextNodePos(doc)
    const node = {
      id: crypto.randomUUID(),
      type,
      positions: { main: pos },
      data: {
        name: name || path.basename(relPath),
        path: relPath,
        provider: 'ffmpeg',
        sourceNodeId: args.source_node_id || undefined,
        ...extraData
      }
    }
    addEdgeToDoc(doc, args.source_node_id, node.id)
    addNode(doc, node)
    return node
  }

  async function probeAbs(absPath) {
    const bins = resolveMediaBins(loadSettings)
    if (!bins.ffmpeg || !bins.ffprobe) throw new Error(bins.reason || FFMPEG_HINT)
    const r = await runBin(bins.ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', absPath], 30_000)
    if (r.code !== 0 || !r.out) throw new Error(`ffprobe failed: ${r.err || 'no output'}`)
    return summarizeProbe(JSON.parse(r.out))
  }

  const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']

  const mediaTools = {
    media_probe: {
      description:
        'Inspect a media file with ffprobe: duration, resolution, fps, codecs, audio presence. Works on images too (duration/size only). Accepts absolute or project-relative paths.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Media file path' } },
        required: ['path']
      },
      async run(args) {
        const abs = path.isAbsolute(args.path) ? args.path : path.join(PROJECT_DIR, args.path)
        if (!fs.existsSync(abs)) return toError(`file not found: ${args.path}`)
        try {
          return toText(JSON.stringify({ status: 'ok', file: args.path, ...await probeAbs(abs) }, null, 2))
        } catch (e) {
          return toError(String(e?.message || e))
        }
      }
    },

    videos_merge: {
      description:
        'Concatenate 2-10 videos into one mp4 in chronological order. When codecs/resolutions differ it re-encodes automatically (slower); identical streams use lossless stream copy. Send one short sentence to the user before calling.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Video paths in merge order (2-10)' },
          output_name: { type: 'string', description: 'Output base name (default merge)' },
          source_node_id: { type: 'string', description: 'Canvas node to link the result to' }
        },
        required: ['paths']
      },
      async run(args) {
        const bins = resolveMediaBins(loadSettings)
        if (!bins.ffmpeg) return toError(bins.reason || FFMPEG_HINT)
        const inputs = (Array.isArray(args.paths) ? args.paths : []).map(String).filter(Boolean)
        if (inputs.length < 2) return toError('videos_merge needs at least 2 input paths')
        if (inputs.length > 10) return toError('videos_merge accepts at most 10 inputs; merge in batches')
        const absInputs = []
        for (const p of inputs) {
          const abs = path.isAbsolute(p) ? p : path.join(PROJECT_DIR, p)
          if (!fs.existsSync(abs)) return toError(`file not found: ${p}`)
          absInputs.push(abs)
        }
        try {
          const probes = await Promise.all(absInputs.map((p) => probeAbs(p)))
          const first = probes[0]
          const same = probes.every(
            (pr) => pr.video_codec === first.video_codec && pr.width === first.width && pr.height === first.height && pr.pix_fmt === first.pix_fmt && pr.has_audio === first.has_audio && pr.audio_codec === first.audio_codec
          )
          const listFile = path.join(PROJECT_DIR, '.entropy', `concat-${Date.now()}.txt`)
          fs.mkdirSync(path.dirname(listFile), { recursive: true })
          fs.writeFileSync(listFile, absInputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8')
          const { rel, abs } = outPath(args.output_name || 'merge', '.mp4')
          const ffArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile]
          if (same) ffArgs.push('-c', 'copy')
          else ffArgs.push(...ENCODE)
          ffArgs.push(abs)
          const r = await runBin(bins.ffmpeg, ffArgs)
          fs.rmSync(listFile, { force: true })
          if (r.code !== 0) return toError(`ffmpeg merge failed: ${r.err.slice(-600)}`)
          const node = addMediaNode(rel, 'video', args.output_name || 'merge', args, { merged: inputs.length, reencoded: !same })
          return toText(
            JSON.stringify(
              { status: 'ok', video: { node_id: node.id, file: rel }, inputs: inputs.length, reencoded: !same, ...await probeAbs(abs), note: 'merged video is on the canvas; deliver the filename in backticks' },
              null,
              2
            )
          )
        } catch (e) {
          return toError(String(e?.message || e))
        }
      }
    },

    trim_video: {
      description:
        'Cut a clip from a video by absolute timestamps (re-encodes for frame accuracy). Use media_probe first to get the real duration.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source video path' },
          start: { type: 'number', description: 'Start seconds, e.g. 0 or 1.5' },
          end: { type: 'number', description: 'End seconds (exclusive)' },
          output_name: { type: 'string', description: 'Output base name (default trim)' },
          source_node_id: { type: 'string', description: 'Canvas node to link the result to' }
        },
        required: ['path', 'start', 'end']
      },
      async run(args) {
        const bins = resolveMediaBins(loadSettings)
        if (!bins.ffmpeg) return toError(bins.reason || FFMPEG_HINT)
        const abs = path.isAbsolute(args.path) ? args.path : path.join(PROJECT_DIR, args.path)
        if (!fs.existsSync(abs)) return toError(`file not found: ${args.path}`)
        const start = Number(args.start)
        const end = Number(args.end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          return toError('need valid timestamps with end > start (seconds)')
        }
        const { rel, abs: outAbs } = outPath(args.output_name || 'trim', '.mp4')
        const r = await runBin(bins.ffmpeg, [
          '-y', '-ss', String(start), '-i', abs, '-t', String(end - start), ...ENCODE, '-movflags', '+faststart', outAbs
        ])
        if (r.code !== 0) return toError(`ffmpeg trim failed: ${r.err.slice(-600)}`)
        const node = addMediaNode(rel, 'video', args.output_name || 'trim', args, { trimmed: [start, end] })
        return toText(JSON.stringify({ status: 'ok', video: { node_id: node.id, file: rel }, ...await probeAbs(outAbs), note: 'trimmed clip is on the canvas; deliver the filename in backticks' }, null, 2))
      }
    },

    subtitle_burn: {
      description:
        'Burn subtitles (SRT/ASS) into a video. Pass style as a libass force_style string (e.g. "FontName=Noto Sans CJK SC,FontSize=18") — omit it to keep the subtitle file\'s own styling (ASS).',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Source video path' },
          subtitle: { type: 'string', description: 'Subtitle file path (.srt or .ass)' },
          style: { type: 'string', description: 'Optional libass force_style, e.g. FontSize=18,PrimaryColour=&H00FFFFFF' },
          output_name: { type: 'string', description: 'Output base name (default subtitled)' },
          source_node_id: { type: 'string', description: 'Canvas node to link the result to' }
        },
        required: ['video', 'subtitle']
      },
      async run(args) {
        const bins = resolveMediaBins(loadSettings)
        if (!bins.ffmpeg) return toError(bins.reason || FFMPEG_HINT)
        const absVideo = path.isAbsolute(args.video) ? args.video : path.join(PROJECT_DIR, args.video)
        const absSub = path.isAbsolute(args.subtitle) ? args.subtitle : path.join(PROJECT_DIR, args.subtitle)
        for (const [label, p] of [['video', absVideo], ['subtitle', absSub]]) {
          if (!fs.existsSync(p)) return toError(`${label} not found: ${p}`)
        }
        // libass subtitle filter path escaping (Windows drive letters are the classic trap):
        // backslashes → slashes, then escape filter-special chars, wrap in single quotes
        const esc = absSub.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\\\'")
        const style = typeof args.style === 'string' && args.style.trim() ? args.style.trim().replace(/'/g, '') : null
        const vf = `subtitles=filename='${esc}'${style ? `:force_style='${style.replace(/:/g, '\\:')}'` : ''}`
        const { rel, abs: outAbs } = outPath(args.output_name || 'subtitled', '.mp4')
        const r = await runBin(bins.ffmpeg, ['-y', '-i', absVideo, '-vf', vf, ...ENCODE, '-movflags', '+faststart', outAbs])
        if (r.code !== 0) return toError(`subtitle burn failed: ${r.err.slice(-600)}`)
        const node = addMediaNode(rel, 'video', args.output_name || 'subtitled', args, { subtitles: args.subtitle, style: style || undefined })
        return toText(JSON.stringify({ status: 'ok', video: { node_id: node.id, file: rel }, ...await probeAbs(outAbs), note: 'subtitled video is on the canvas; deliver the filename in backticks' }, null, 2))
      }
    },

    media_montage: {
      description:
        'Build a high-density keyframe contact sheet (拼图) from a video: samples frames evenly and tiles them into one PNG per sheet, ' +
        'placed on the canvas as image nodes. Use for shot-by-shot video deconstruction and whole-clip quality review in one look. ' +
        'per_sheet 1-12 (default 12, laid out 4 cols), max_sheets 1-4.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Source video path (absolute or project-relative)' },
          per_sheet: { type: 'number', description: 'Frames per sheet, 1-12 (default 12)' },
          max_sheets: { type: 'number', description: 'Sheets to produce, 1-4 (default 2)' },
          output_name: { type: 'string', description: 'Output base name (default montage)' },
          source_node_id: { type: 'string', description: 'Canvas node to link the sheets to' }
        },
        required: ['video']
      },
      async run(args) {
        const bins = resolveMediaBins(loadSettings)
        if (!bins.ffmpeg) return toError(bins.reason || FFMPEG_HINT)
        const abs = path.isAbsolute(args.video) ? args.video : path.join(PROJECT_DIR, args.video)
        if (!fs.existsSync(abs)) return toError(`file not found: ${args.video}`)
        const perSheet = Math.min(Math.max(Number(args.per_sheet) || 12, 1), 12)
        const sheets = Math.min(Math.max(Number(args.max_sheets) || 2, 1), 4)
        const cols = Math.min(perSheet, 4)
        const rows = Math.ceil(perSheet / cols)
        let fps = 1
        try {
          const info = await probeAbs(abs)
          if (info.duration_seconds > 0) fps = Math.min(Math.max(perSheet / info.duration_seconds, 0.05), 5)
        } catch {
          /* unknown duration → 1 fps sampling */
        }
        const genDir = path.join(PROJECT_DIR, 'generated')
        fs.mkdirSync(genDir, { recursive: true })
        const stem = slugify(`${args.output_name || 'montage'}.png`).replace(/\.png$/, '')
        const r = await runBin(bins.ffmpeg, [
          '-y', '-i', abs,
          '-vf', `fps=${fps.toFixed(3)},scale=320:-2,tile=${cols}x${rows}`,
          '-frames:v', String(sheets),
          path.join(genDir, `${stem}-%02d.png`)
        ], 120_000)
        if (r.code !== 0) return toError(`montage failed: ${r.err.slice(-600)}`)
        const produced = fs
          .readdirSync(genDir)
          .filter((f) => f.startsWith(stem + '-') && /^\d+\.png$/.test(f.slice(stem.length + 1)))
          .sort()
          .map((f) => `generated/${f}`)
        if (produced.length === 0) return toError('montage produced no sheets (video too short or decode failed)')
        const nodes = produced.map((relPath) => addMediaNode(relPath, 'image', path.basename(relPath), args, { montageOf: args.video, grid: `${cols}x${rows}` }))
        return toText(
          JSON.stringify(
            {
              status: 'ok',
              sheets: nodes.map((n, i) => ({ node_id: n.id, file: produced[i] })),
              grid: `${cols}x${rows}`,
              fps: Math.round(fps * 1000) / 1000,
              note: 'contact sheets are on the canvas; media_analyse can read a sheet as one image for dense review'
            },
            null,
            2
          )
        )
      }
    },

    extract_audio: {
      description: 'Extract the audio track of a video as mp3 (for BGM reuse, dubbing reference, or music analysis).',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Source video path' },
          output_name: { type: 'string', description: 'Output base name (default audio)' },
          source_node_id: { type: 'string', description: 'Canvas node to link the result to' }
        },
        required: ['video']
      },
      async run(args) {
        const bins = resolveMediaBins(loadSettings)
        if (!bins.ffmpeg) return toError(bins.reason || FFMPEG_HINT)
        const abs = path.isAbsolute(args.video) ? args.video : path.join(PROJECT_DIR, args.video)
        if (!fs.existsSync(abs)) return toError(`file not found: ${args.video}`)
        const info = await probeAbs(abs).catch(() => null)
        if (info && !info.has_audio) return toError('the source video has no audio track')
        const { rel, abs: outAbs } = outPath(args.output_name || 'audio', '.mp3')
        const r = await runBin(bins.ffmpeg, ['-y', '-i', abs, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', outAbs])
        if (r.code !== 0) return toError(`audio extraction failed: ${r.err.slice(-600)}`)
        const node = addMediaNode(rel, 'audio', args.output_name || 'audio', args, { extractedFrom: args.video })
        return toText(JSON.stringify({ status: 'ok', audio: { node_id: node.id, file: rel } }, null, 2))
      }
    }
  }

  // keep crypto usage local to this module (server.mjs passes helpers, not its imports)
  return mediaTools
}