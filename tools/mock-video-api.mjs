// Mock task-style video API for testing the "custom" provider adapter.
// Shape follows the Kling-style submit/poll convention (the adapter's defaults).
import http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'

const PORT = 4597
// 写临时目录，避免 mock 产物污染仓库（曾把假 mp4 写进 assets/）
const DUMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mock-video-'))
const tasks = new Map() // id -> { createdAt, file }

// 1x1 black mp4 (tiny valid-ish payload is unnecessary — adapter just downloads bytes)
const DUMMY_MP4 = Buffer.from(
  'AAAAAm1wNDAAAAAAAAAAAAA=',
  'base64'
)

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)

  if (req.method === 'POST' && url.pathname === '/api/video/submit') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        /* tolerate malformed bodies — the mock is only exercised with JSON */
      }
      const id = 'task_' + crypto.randomUUID().slice(0, 8)
      const file = path.join(DUMP_DIR, `mock-video-${id}.mp4`)
      fs.writeFileSync(file, DUMMY_MP4)
      tasks.set(id, { createdAt: Date.now(), file, prompt: parsed.prompt })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { task_id: id } }))
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/video/query') {
    const id = url.searchParams.get('task_id')
    const t = tasks.get(id)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (!t) {
      res.end(JSON.stringify({ data: { task_status: 'failed' } }))
      return
    }
    if (Date.now() - t.createdAt < 2000) {
      res.end(JSON.stringify({ data: { task_status: 'processing' } }))
      return
    }
    res.end(
      JSON.stringify({
        data: {
          task_status: 'succeed',
          task_result: { videos: [{ url: `http://127.0.0.1:${PORT}/files/${id}.mp4` }] }
        }
      })
    )
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const id = url.pathname.slice('/files/'.length).replace('.mp4', '')
    const t = tasks.get(id)
    if (!t) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(fs.readFileSync(t.file))
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock video api on http://127.0.0.1:${PORT}`))
