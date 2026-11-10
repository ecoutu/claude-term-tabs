import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectLiveSessions } from '../src/live.ts'
import { DigestCache } from '../src/cache.ts'
import type { Exec } from '../src/types.ts'
import { fixture } from './helpers.ts'

const fakePs = (out: string): Exec => (cmd) => {
  assert.equal(cmd, 'ps')
  return { status: 0, stdout: out, stderr: '' }
}
const opts = (exec: Exec) => ({
  sessionsDir: fixture('sessions'),
  projectsDir: fixture('projects'),
  exec,
  cache: DigestCache.load(join(mkdtempSync(join(tmpdir(), 'ct-live-')), 'c.json'), () => {})
})

test('keeps live cli sessions with tty', () => {
  const c = collectLiveSessions(opts(fakePs(' 5176 ttys022  /opt/bin/claude\n 6000 ttys001 claude\n')))
  assert.equal(c.length, 1)
  assert.equal(c[0].tty, '/dev/ttys022')
  assert.equal(c[0].status, 'shell')
  assert.equal(c[0].live, true)
  assert.equal(c[0].digest.title, 'Social one')
})

test('ignores a pid reused by a non-claude process', () => {
  assert.equal(collectLiveSessions(opts(fakePs('5176 ttys022 zsh\n'))).length, 0)
})

test('dead pids are dropped and unknown status maps to unknown', () => {
  const c = collectLiveSessions(opts(fakePs('7000 ?? claude\n')))
  assert.equal(c.length, 1)
  assert.equal(c[0].status, 'unknown')
  assert.equal(c[0].tty, undefined)
})

test('finds a transcript under another project dir by session id', () => {
  const c = collectLiveSessions(opts(fakePs('5177 ttys005 claude\n')))
  assert.equal(c[0].digest.title, 'Moved one')
})

test('ps failure throws', () => {
  const failing: Exec = () => ({ status: 1, stdout: '', stderr: 'boom' })
  assert.throws(() => collectLiveSessions(opts(failing)), /ps/)
})
