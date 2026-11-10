import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clearWinner, rankLocal, tokenize } from '../src/score.ts'
import type { Candidate } from '../src/types.ts'
import { fixture } from './helpers.ts'

const NOW = 1_800_000_000_000
interface Row { sessionId: string, cwd: string, repo: string, worktree?: string, title?: string, branch?: string, ageMinutes: number }
const rows = JSON.parse(readFileSync(fixture('real-sessions.json'), 'utf8')) as Row[]
const cand = (r: Row): Candidate => ({
  live: true,
  status: 'idle',
  digest: { sessionId: r.sessionId, cwd: r.cwd, repo: r.repo, worktree: r.worktree, title: r.title, branch: r.branch, lastActive: NOW - r.ageMinutes * 60_000 }
})
const real = rows.map(cand)
const winnerTitle = (q: string) => clearWinner(rankLocal(q, real, NOW))?.digest.title

test('filler-only query tokenizes to nothing', () =>
  assert.deepEqual(tokenize('working on the session'), []))

test('tokenize keeps hyphenated words and ticket ids whole, lowercased', () =>
  assert.deepEqual(tokenize('Envoy in API-Proxy for TKT-7730'), ['envoy', 'api-proxy', 'tkt-7730']))

test('envoy api-accounts resolves locally', () =>
  assert.equal(winnerTitle('envoy api-accounts'), 'Envoy api-accounts exposure and staging'))

test('the original example resolves locally', () =>
  assert.equal(winnerTitle('working on envoy in api-proxy'), 'Envoy api-accounts exposure and staging'))

test('csv ingestion is ambiguous', () => {
  const ranked = rankLocal('csv ingestion', real, NOW)
  assert.equal(clearWinner(ranked), undefined)
  assert.ok(ranked.length >= 2)
})

test('TKT ticket ids match exactly', () =>
  assert.equal(winnerTitle('TKT-7730'), 'TKT-7730 domains name case-insensitive unique'))

test('ticket id does not match a longer id by prefix', () =>
  assert.equal(rankLocal('TKT-773', real, NOW).length, 0))

test('prefix of a word matches', () =>
  assert.equal(winnerTitle('vendor renam'), 'TKT-7733 TKT-7732 Vendor renamed handle refresh'))

test('a repo name shared by many sessions is not a clear winner', () =>
  assert.equal(winnerTitle('api-orders'), undefined))

test('non-matching query ranks nothing', () =>
  assert.deepEqual(rankLocal('kubernetes', real, NOW), []))

test('recency breaks a tie', () => {
  const older = cand({ sessionId: 'a', cwd: '/x/r', repo: 'r', title: 'same words', ageMinutes: 600 })
  const newer = cand({ sessionId: 'b', cwd: '/x/r', repo: 'r', title: 'same words', ageMinutes: 5 })
  assert.equal(rankLocal('same words', [older, newer], NOW)[0].cand.digest.sessionId, 'b')
})
