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

test('only assistant text after the stop prompt message counts', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { latestAssistantAfterPrompt } = await import('../src/handoff.ts')
  const f = join(mkdtempSync(join(tmpdir(), 'ctt-ho-')), 't.jsonl')
  const L = (o: unknown) => JSON.stringify(o)
  const lines = [
    L({ type: 'assistant', timestamp: '2026-11-10T10:00:05Z', message: { content: [{ type: 'text', text: 'Docs:\nHANDOFF heading explained' }] } })
  ]
  writeFileSync(f, lines.join('\n') + '\n')
  const since = Date.parse('2026-11-10T10:00:00Z')
  assert.equal(latestAssistantAfterPrompt(f, 'Pausing for a machine restart.', since), undefined)
  writeFileSync(f, [...lines,
    L({ type: 'user', timestamp: '2026-11-10T10:00:10Z', message: { content: 'Pausing for a machine restart. Stop at the nearest safe point' } }),
    L({ type: 'assistant', timestamp: '2026-11-10T10:00:20Z', message: { content: [{ type: 'text', text: 'HANDOFF\n- Goal: x' }] } })
  ].join('\n') + '\n')
  assert.equal(latestAssistantAfterPrompt(f, 'Pausing for a machine restart.', since), 'HANDOFF\n- Goal: x')
})

test('a stop prompt that Claude Code recorded as pasted content still counts', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { latestAssistantAfterPrompt } = await import('../src/handoff.ts')
  const f = join(mkdtempSync(join(tmpdir(), 'ctt-ho-')), 't.jsonl')
  const L = (o: unknown) => JSON.stringify(o)
  writeFileSync(f, [
    L({ type: 'user', timestamp: '2026-11-10T10:00:10Z', message: { content: '\n\n<pasted_content id="29f2">\nPausing for a machine restart. Stop at the nearest safe point\n</pasted_content id="29f2">\n' } }),
    L({ type: 'assistant', timestamp: '2026-11-10T10:00:20Z', message: { content: [{ type: 'text', text: 'HANDOFF\n- Goal: x' }] } })
  ].join('\n') + '\n')
  assert.equal(latestAssistantAfterPrompt(f, 'Pausing for a machine restart.', Date.parse('2026-11-10T10:00:00Z')), 'HANDOFF\n- Goal: x')
})

test('a pasted stop prompt after typed text is not the stop prompt', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { latestAssistantAfterPrompt } = await import('../src/handoff.ts')
  const f = join(mkdtempSync(join(tmpdir(), 'ctt-ho-')), 't.jsonl')
  const L = (o: unknown) => JSON.stringify(o)
  writeFileSync(f, [
    L({ type: 'user', timestamp: '2026-11-10T10:00:10Z', message: { content: 'what does this mean?\n\n<pasted_content id="29f2">\nPausing for a machine restart.\n</pasted_content id="29f2">\n' } }),
    L({ type: 'assistant', timestamp: '2026-11-10T10:00:20Z', message: { content: [{ type: 'text', text: 'HANDOFF is a heading' }] } })
  ].join('\n') + '\n')
  assert.equal(latestAssistantAfterPrompt(f, 'Pausing for a machine restart.', Date.parse('2026-11-10T10:00:00Z')), undefined)
})
