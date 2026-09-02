// Download an ffmpeg Windows build and drop ffmpeg.exe/ffprobe.exe into vendor/ffmpeg/win/.
// Zero dependencies: global fetch + the system tar (bsdtar ships with Windows 10+).
//
// Usage:
//   node tools/fetch-ffmpeg.mjs            # print recommended sources
//   node tools/fetch-ffmpeg.mjs <zip-url>  # download + extract

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'ffmpeg', 'win')

const SOURCES = [
  'https://www.gyan.dev/ffmpeg/builds/  →  ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases  →  ffmpeg-master-latest-win64-gpl.zip'
]

const url = process.argv[2]
if (!url || !/^https:\/\//.test(url)) {
  console.log('用法: node tools/fetch-ffmpeg.mjs <zip 直链>\n')
  console.log('推荐来源（打开页面复制 zip 直链）:')
  for (const s of SOURCES) console.log('  - ' + s)
  console.log('\n或手动把 ffmpeg.exe / ffprobe.exe 放进 ' + DEST)
  process.exit(url ? 1 : 0)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-fetch-'))
const zipPath = path.join(tmpDir, 'ffmpeg.zip')

try {
  console.log(`下载 ${url} ...`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(zipPath, buf)
  console.log(`下载完成 ${(buf.length / 1e6).toFixed(1)}MB，解压中...`)

  const exDir = path.join(tmpDir, 'extracted')
  fs.mkdirSync(exDir, { recursive: true })
  // On Windows, prefer the system bsdtar (System32\tar.exe): it handles Windows
  // paths natively, whereas a GNU tar earlier on PATH (Git Bash) misreads
  // "C:\..." as a remote-host path. Fall back to PATH tar if System32 is absent.
  const sysTar = process.platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
    : null
  const tar = spawnSync(sysTar && fs.existsSync(sysTar) ? sysTar : 'tar', ['-xf', zipPath, '-C', exDir], { windowsHide: true })
  if (tar.status !== 0) throw new Error(`tar 解压失败: ${(tar.stderr || '').toString().slice(0, 300)}`)

  const found = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'ffmpeg.exe' || entry.name === 'ffprobe.exe') found[entry.name] = p
    }
  }
  walk(exDir)

  fs.mkdirSync(DEST, { recursive: true })
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    if (!found[name]) throw new Error(`压缩包内未找到 ${name}`)
    fs.copyFileSync(found[name], path.join(DEST, name))
    console.log(`✓ ${name} → ${path.join(DEST, name)}`)
  }
  console.log('\n完成。现在 npm run dist 会把 ffmpeg 打进安装包。')
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
