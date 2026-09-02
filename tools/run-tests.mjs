// Deterministic unit-test runner: node --test glob/dir semantics differ between
// Node versions (CI pins 20, devs float), so we list the files explicitly.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const dir = path.resolve('tests')
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => path.join(dir, f))
  .sort()
if (!files.length) {
  console.error('no *.test.mjs files found in tests/')
  process.exit(1)
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
