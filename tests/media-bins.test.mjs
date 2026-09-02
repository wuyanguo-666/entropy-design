// Unit tests for ffmpeg/ffprobe binary resolution (settings → bundled → PATH),
// the first rung of the media post-production line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolveMediaBins } from '../mcp/media-tools.mjs'

const exe = process.platform === 'win32' ? '.exe' : ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-unit-bins-'))
const touch = (dir, base) => {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, base + exe)
  fs.writeFileSync(f, '')
  return f
}

const bundledDir = touch(tmp, 'ffmpeg') && tmp // dir containing only ffmpeg (no ffprobe)
fs.writeFileSync(bundledDir + path.sep + 'ffprobe' + exe, '')

test('explicit settings file wins, sibling ffprobe picked up', () => {
  const r = resolveMediaBins(() => ({ media: { ffmpegPath: path.join(bundledDir, 'ffmpeg' + exe) } }))
  assert.equal(r.ffmpeg, path.join(bundledDir, 'ffmpeg' + exe))
  assert.equal(r.ffprobe, path.join(bundledDir, 'ffprobe' + exe))
})

test('settings directory containing the binaries also works', () => {
  const r = resolveMediaBins(() => ({ media: { ffmpegPath: ' ' + bundledDir + '  ' } }))
  assert.equal(r.ffmpeg, path.join(bundledDir, 'ffmpeg' + exe))
})

test('bundled ED_FFMPEG_DIR beats PATH', () => {
  const prev = process.env.ED_FFMPEG_DIR
  process.env.ED_FFMPEG_DIR = bundledDir
  try {
    const r = resolveMediaBins(() => null)
    assert.equal(r.ffmpeg, path.join(bundledDir, 'ffmpeg' + exe))
  } finally {
    if (prev === undefined) delete process.env.ED_FFMPEG_DIR
    else process.env.ED_FFMPEG_DIR = prev
  }
})

test('nothing found yields null + the setup hint (PATH emptied)', () => {
  const prevPath = process.env.PATH
  const prevBundled = process.env.ED_FFMPEG_DIR
  process.env.PATH = ''
  delete process.env.ED_FFMPEG_DIR
  try {
    const r = resolveMediaBins(() => ({ media: { ffmpegPath: 'C:\\nowhere\\ffmpeg.exe' } }))
    assert.equal(r.ffmpeg, null)
    assert.equal(r.ffprobe, null)
    assert.match(r.reason, /ffmpeg 未找到/)
  } finally {
    process.env.PATH = prevPath
    if (prevBundled) process.env.ED_FFMPEG_DIR = prevBundled
  }
})
