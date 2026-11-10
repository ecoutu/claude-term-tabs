import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  const c = collectLiveSessions(opts(fakePs(' 5176 ttys022 01:00 /opt/bin/claude\n 6000 ttys001 01:00 claude\n')))
  assert.equal(c.length, 1)
  assert.equal(c[0].tty, '/dev/ttys022')
  assert.equal(c[0].status, 'shell')
  assert.equal(c[0].live, true)
  assert.equal(c[0].digest.title, 'Social one')
})

test('ignores a pid reused by a non-claude process', () => {
  assert.equal(collectLiveSessions(opts(fakePs('5176 ttys022 01:00 zsh\n'))).length, 0)
})

test('dead pids are dropped and unknown status maps to unknown', () => {
  const c = collectLiveSessions(opts(fakePs('7000 ?? 01:00 claude\n')))
  assert.equal(c.length, 1)
  assert.equal(c[0].status, 'unknown')
  assert.equal(c[0].tty, undefined)
})

test('finds a transcript under another project dir by session id', () => {
  const c = collectLiveSessions(opts(fakePs('5177 ttys005 01:00 claude\n')))
  assert.equal(c[0].digest.title, 'Moved one')
})

test('ps failure throws', () => {
  const failing: Exec = () => ({ status: 1, stdout: '', stderr: 'boom' })
  assert.throws(() => collectLiveSessions(opts(failing)), /ps/)
})

test('a pid whose process started after the session file is a reused pid', () => {
  const now = Date.now()
  const dir = mkdtempSync(join(tmpdir(), 'ct-reuse-'))
  writeFileSync(join(dir, '42.json'), JSON.stringify({ pid: 42, sessionId: 'R', cwd: '/x', status: 'idle', entrypoint: 'cli', startedAt: now - 3 * 3_600_000 }))
  writeFileSync(join(dir, '43.json'), JSON.stringify({ pid: 43, sessionId: 'K', cwd: '/x', status: 'idle', entrypoint: 'cli', startedAt: now - 3 * 3_600_000 }))
  const ps: Exec = () => ({ status: 0, stdout: '42 ttys001 05:00 claude\n43 ttys002 03:00:05 claude\n', stderr: '' })
  const c = collectLiveSessions({ ...opts(ps), sessionsDir: dir, now: () => now })
  assert.deepEqual(c.map(x => x.digest.sessionId), ['K'])
})

test('missing sessions directory means no live sessions', () =>
  assert.deepEqual(collectLiveSessions({ ...opts(fakePs('')), sessionsDir: '/nope/sessions' }), []))

test('live candidates carry their pid', () =>
  assert.equal(collectLiveSessions(opts(fakePs('5176 ttys022 01:00 claude\n')))[0].pid, 5176))
