// Unit tests for the pure provider helpers: Kling JWT signing (HS256), the
// JSONPath-lite resolver used by the custom task-style adapter, and filename slugs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'

import { signKlingJwt, slugifyVideo, getPath } from '../mcp/video-providers.mjs'

function decode(jwtPart) {
  return JSON.parse(Buffer.from(jwtPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'))
}

test('signKlingJwt produces a verifiable HS256 JWT with iss/exp/nbf', () => {
  const now = 1750000000000 // fixed clock: the test must not age
  const jwt = signKlingJwt('AK-test', 'secret-test', now)
  const [h, p, s] = jwt.split('.')
  assert.ok(h && p && s && jwt.split('.').length === 3)
  assert.deepEqual(decode(h), { alg: 'HS256', typ: 'JWT' })
  const payload = decode(p)
  assert.equal(payload.iss, 'AK-test')
  assert.equal(payload.exp, Math.floor(now / 1000) + 1800) // 30-min validity
  assert.equal(payload.nbf, Math.floor(now / 1000) - 5) // small skew
  const expect = crypto.createHmac('sha256', 'secret-test').update(`${h}.${p}`).digest('base64url')
  assert.equal(s, expect)
})

test('getPath resolves dotted + indexed custom-API paths', () => {
  const doc = { data: { task_status: 'succeed', task_result: { videos: [{ url: 'http://x/v.mp4' }] } } }
  assert.equal(getPath(doc, 'data.task_status'), 'succeed')
  assert.equal(getPath(doc, 'data.task_result.videos[0].url'), 'http://x/v.mp4')
  assert.equal(getPath(doc, 'data.task_result.videos[1].url'), undefined) // out of range
  assert.equal(getPath(doc, 'missing.deep.path'), undefined) // no throw on holes
  assert.equal(getPath(null, 'a'), undefined)
  assert.equal(getPath(doc, ''), undefined)
  assert.equal(getPath({ a: 0 }, 'a'), 0) // falsy values survive
})

test('slugifyVideo sanitizes and caps the stem', () => {
  const name = slugifyVideo('最终版/镜头 01：大片 v2?.mp4')
  assert.match(name, /^[^\\/:*?"<>|\s]{1,48}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.mp4$/)
  assert.ok(!/[\\/:*?"<>|\s]/.test(name.split('-2026')[0] || name.slice(0, 40)))
  assert.equal(slugifyVideo('').startsWith('video-'), true)
  assert.ok(slugifyVideo('x'.repeat(80)).slice(0, 48) === 'x'.repeat(48))
})
