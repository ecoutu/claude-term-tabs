import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestSnapshot, pruneSnapshots, saveSnapshot, snapshotFrom } from '../src/snapshot.ts'
import type { Candidate } from '../src/types.ts'

const NOW = Date.parse('2026-11-10T18:00:00.123Z')
const dir = () => join(mkdtempSync(join(tmpdir(), 'ct-snap-')), 'snapshots')
const cand: Candidate = {
  live: true, status: 'idle', pid: 1,
  digest: { sessionId: 'S1', cwd: '/w/api-proxy', repo: 'api-proxy', branch: 'main', title: 'Envoy', lastActive: 1 },
  pane: { id: 'p', tty: '/dev/ttys1', title: '', windowId: 'w', windowIndex: 2, tabIndex: 5 }
}

test('snapshotFrom records sessions with tab position and an id from the time', () => {
  const s = snapshotFrom([cand], 'iterm2', NOW)
  assert.equal(s.id, '2026-11-10T18-00-00.123Z')
  assert.equal(s.createdAt, '2026-11-10T18:00:00.123Z')
  assert.deepEqual(s.sessions, [{ sessionId: 'S1', cwd: '/w/api-proxy', title: 'Envoy', repo: 'api-proxy', branch: 'main', windowIndex: 2, tabIndex: 5, terminal: 'iterm2', handoffWritten: false }])
})

test('save then latest round-trips, owner-only', () => {
  const d = dir()
  const path = saveSnapshot(d, snapshotFrom([cand], 'iterm2', NOW))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(latestSnapshot(d)?.sessions[0].sessionId, 'S1')
})

test('latest picks the newest by createdAt', () => {
  const d = dir()
  for (const t of [NOW - 2000, NOW, NOW - 1000]) saveSnapshot(d, snapshotFrom([cand], 'iterm2', t))
  assert.equal(latestSnapshot(d)?.createdAt, new Date(NOW).toISOString())
})

test('missing directory gives undefined', () =>
  assert.equal(latestSnapshot('/nope/snapshots'), undefined))

test('a corrupt newest snapshot throws naming it', () => {
  const d = dir()
  saveSnapshot(d, snapshotFrom([cand], 'iterm2', NOW - 1000))
  writeFileSync(join(d, '2026-11-11T00-00-00.000Z.json'), '{bad')
  assert.throws(() => latestSnapshot(d), /2026-11-11T00-00-00\.000Z\.json/)
})

test('prune removes only snapshots older than the cutoff', () => {
  const d = dir()
  const old = saveSnapshot(d, snapshotFrom([cand], 'iterm2', NOW - 40 * 86_400_000))
  const fresh = saveSnapshot(d, snapshotFrom([cand], 'iterm2', NOW - 86_400_000))
  utimesSync(old, new Date(), new Date())
  assert.deepEqual(pruneSnapshots(d, NOW, 30 * 86_400_000), [old])
  assert.deepEqual(readdirSync(d).map(f => join(d, f)), [fresh])
})
