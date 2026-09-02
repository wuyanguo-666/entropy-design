// Stages the platform ffmpeg binaries for electron-builder extraResources.
// The yml can't interpolate the build platform into `from:`, so the dist scripts
// run this first: vendor/ffmpeg/<platform> -> vendor/ffmpeg/current.
// A missing source is NOT an error — the app falls back to PATH ffmpeg; the dir
// only has to EXIST because electron-builder fails on absent extraResources sources.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor', 'ffmpeg')
const PLAT = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform] || process.platform
const src = path.join(vendor, PLAT)
const dest = path.join(vendor, 'current')

fs.rmSync(dest, { recursive: true, force: true })
if (fs.existsSync(src)) {
  fs.cpSync(src, dest, { recursive: true })
  const names = fs.readdirSync(dest).join(', ')
  console.log(`[stage-ffmpeg] ${PLAT}: staged ${dest} (${names})`)
} else {
  fs.mkdirSync(dest, { recursive: true })
  console.log(`[stage-ffmpeg] ${PLAT}: no vendor/ffmpeg/${PLAT} — shipping empty (runtime falls back to PATH)`)
}
