import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listClosedSessions, resumeCommand } from '../src/history.ts'
import { DigestCache } from '../src/cache.ts'
import { fixture } from './helpers.ts'

const cache = () => DigestCache.load(join(mkdtempSync(join(tmpdir(), 'ct-hist-')), 'c.json'), () => {})

test('lists transcripts except live ones', () => {
  const c = listClosedSessions({ projectsDir: fixture('projects'), liveIds: new Set(['S1']), cache: cache(), dirExists: () => true })
  assert.deepEqual(c.map(x => x.digest.sessionId), ['S2'])
  assert.equal(c[0].live, false)
  assert.equal(c[0].digest.title, 'Moved one')
})

test('cwd that no longer exists is marked dir gone', () => {
  const c = listClosedSessions({ projectsDir: fixture('projects'), liveIds: new Set(), cache: cache(), dirExists: () => false })
  assert.ok(c.length === 2 && c.every(x => x.dirGone === true))
})

test('default resume command', () =>
  assert.equal(resumeCommand({}, 'S'), 'claude --resume S'))

test('configured resume command substitutes the id', () =>
  assert.equal(resumeCommand({ resumeCommand: 'claude --dangerously-skip-permissions --resume {id}' }, 'S'),
    'claude --dangerously-skip-permissions --resume S'))

test('template without {id} throws', () =>
  assert.throws(() => resumeCommand({ resumeCommand: 'claude' }, 'S'), /\{id\}/))
