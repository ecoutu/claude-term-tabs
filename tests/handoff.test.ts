import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasHandoff, latestAssistantText } from '../src/handoff.ts'
import { fixture } from './helpers.ts'

const file = fixture('transcript-handoff.jsonl')
const at = (iso: string) => Date.parse(iso)

test('returns the newest assistant text since the cutoff, skipping tool-only entries', () =>
  assert.equal(latestAssistantText(file, at('2026-11-10T09:00:00Z'), { tailBytes: 512 }), 'working on it'))

test('nothing after the cutoff returns undefined', () =>
  assert.equal(latestAssistantText(file, at('2026-11-11T00:00:00Z')), undefined))

test('an older HANDOFF is not returned for a later cutoff', () =>
  assert.ok(!hasHandoff(latestAssistantText(file, at('2026-11-09T12:00:00Z')))))

test('the newest text wins even when an older one also qualifies', () =>
  assert.equal(latestAssistantText(file, at('2026-11-09T00:00:00Z'), { tailBytes: 512 }), 'working on it'))

test('missing transcript returns undefined', () =>
  assert.equal(latestAssistantText('/nope.jsonl', 0), undefined))

test('hasHandoff matches a heading at a line start only', () => {
  for (const t of ['HANDOFF\n- Goal', 'Done.\n## HANDOFF\n- x', '**HANDOFF**\n- x', '  HANDOFF:']) assert.equal(hasHandoff(t), true, t)
  for (const t of ['I will write a HANDOFF later', 'HANDOFFS are good', undefined]) assert.equal(hasHandoff(t), false, String(t))
})
