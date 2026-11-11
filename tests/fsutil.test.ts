import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOwnerOnly } from '../src/fsutil.ts'

test('writeOwnerOnly creates an owner-only dir and file with no temp left behind', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ctt-fs-')), 'a', 'b.json')
  writeOwnerOnly(file, 'hi')
  assert.equal(readFileSync(file, 'utf8'), 'hi')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(join(file, '..')), ['b.json'])
})

test('writeOwnerOnly tightens an existing loose directory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ctt-fs-')), 'loose')
  mkdirSync(dir, { mode: 0o755 })
  writeOwnerOnly(join(dir, 'x'), 'y')
  assert.equal(statSync(dir).mode & 0o777, 0o700)
})
