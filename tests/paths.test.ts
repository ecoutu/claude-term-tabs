import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoName, transcriptPath } from '../src/paths.ts'

test('repoName uses last segment', () =>
  assert.deepEqual(repoName('/Users/e/src/api-proxy'), { repo: 'api-proxy' }))

test('repoName unwraps worktrees', () =>
  assert.deepEqual(repoName('/Users/e/src/api-orders/.claude/worktrees/tkt-7730'),
    { repo: 'api-orders', worktree: 'tkt-7730' }))

test('repoName tolerates a trailing slash', () =>
  assert.deepEqual(repoName('/Users/e/src/api-proxy/'), { repo: 'api-proxy' }))

test('transcriptPath replaces every non-alphanumeric', () =>
  assert.equal(transcriptPath('/p', '/Users/e/src/a_b/.claude/worktrees/x', 'S'),
    '/p/-Users-e-src-a-b--claude-worktrees-x/S.jsonl'))
