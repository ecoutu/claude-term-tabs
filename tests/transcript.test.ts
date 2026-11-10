import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractDigest } from '../src/transcript.ts'
import { fixture } from './helpers.ts'

test('takes latest title, first real prompt, last prompt, latest branch', () => {
  const d = extractDigest(fixture('transcript-basic.jsonl'), { sessionId: 'S' }, { tailBytes: 4096 })
  assert.equal(d.title, 'Envoy api-accounts exposure')
  assert.equal(d.firstPrompt, 'Is envoy exposing api-accounts?')
  assert.equal(d.lastPrompt, 'check staging too')
  assert.equal(d.branch, 'tkt-1')
  assert.equal(d.cwd, '/Users/e/src/api-accounts')
  assert.equal(d.repo, 'api-accounts')
  assert.ok(d.lastActive > 0)
})

test('custom-title beats ai-title', () => {
  const d = extractDigest(fixture('transcript-custom.jsonl'), { sessionId: 'S' })
  assert.equal(d.title, 'My name')
})

test('half-written final line is skipped', () => {
  const d = extractDigest(fixture('transcript-truncated.jsonl'), { sessionId: 'S' }, { tailBytes: 4096 })
  assert.equal(d.title, 'Envoy api-accounts exposure')
})

test('tail window grows until a title is found', () => {
  const d = extractDigest(fixture('transcript-title-early.jsonl'), { sessionId: 'S' }, { tailBytes: 64 })
  assert.equal(d.title, 'Early title')
})

test('missing file returns fallback digest with note', () => {
  const d = extractDigest('/nope.jsonl', { sessionId: 'S', cwd: '/x/api-proxy' })
  assert.equal(d.repo, 'api-proxy')
  assert.equal(d.sessionId, 'S')
  assert.match(d.note ?? '', /transcript/)
})

test('prompts trimmed to 200 chars', () => {
  const d = extractDigest(fixture('transcript-long-prompt.jsonl'), { sessionId: 'S' })
  assert.equal(d.firstPrompt?.length, 200)
})
