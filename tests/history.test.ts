import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isExcluded, isResumableDir, listClosedSessions, resumeCommand } from '../src/history.ts'
import { DigestCache } from '../src/cache.ts'
import { fixture } from './helpers.ts'

const cache = () => DigestCache.load(join(mkdtempSync(join(tmpdir(), 'ctt-hist-')), 'c.json'), () => {})

test('lists transcripts except live ones', () => {
  const c = listClosedSessions({ projectsDir: fixture('projects'), liveIds: new Set(['S1']), excludeDirs: [], cache: cache(), dirExists: () => true })
  assert.deepEqual(c.map(x => x.digest.sessionId), ['S2'])
  assert.equal(c[0].live, false)
  assert.equal(c[0].digest.title, 'Moved one')
})

test('cwd that no longer exists is marked dir gone', () => {
  const c = listClosedSessions({ projectsDir: fixture('projects'), liveIds: new Set(), excludeDirs: [], cache: cache(), dirExists: () => false })
  assert.ok(c.length === 2 && c.every(x => x.dirGone === true))
})

test('default resume command', () =>
  assert.equal(resumeCommand({}, 'S'), 'claude --resume S'))

test('configured resume command substitutes the id', () =>
  assert.equal(resumeCommand({ resumeCommand: 'claude --dangerously-skip-permissions --resume {id}' }, 'S'),
    'claude --dangerously-skip-permissions --resume S'))

test('template without {id} throws', () =>
  assert.throws(() => resumeCommand({ resumeCommand: 'claude' }, 'S'), /\{id\}/))

test('an id that looks like an option is refused', () =>
  assert.throws(() => resumeCommand({}, '--dangerous'), /unexpected session id/))

test('a relative or unnormalized cwd is never resumable', () => {
  assert.equal(isResumableDir('relative/path', () => true), false)
  assert.equal(isResumableDir('/a/../etc', () => true), false)
  assert.equal(isResumableDir('/a/b', () => true), true)
  assert.equal(isResumableDir('/a/b', () => false), false)
})

test('a dir excludes itself and what is below it, not siblings that share a prefix', () => {
  assert.equal(isExcluded('/w/scratch', ['/w/scratch']), true)
  assert.equal(isExcluded('/w/scratch/sub', ['/w/scratch']), true)
  assert.equal(isExcluded('/w/scratch-2', ['/w/scratch']), false)
  assert.equal(isExcluded('/w/other', ['/w/scratch']), false)
  assert.equal(isExcluded('', ['/w/scratch']), false)
  assert.equal(isExcluded('/anything', ['/']), true)
  assert.equal(isExcluded('/w/scratch/../real-repo', ['/w/scratch']), false)
  assert.equal(isExcluded('/w/other/../scratch/x', ['/w/scratch']), true)
})
