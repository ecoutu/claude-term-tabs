import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, MAY_NEED_YOU_AFTER_MS, STRAGGLER_STATES, type ClassifyInput } from '../src/pause/state.ts'

const base: ClassifyInput = { alive: true, status: 'idle', hasPane: true, handoff: false, msSinceGrowth: 0 }
const cases: Array<[string, Partial<ClassifyInput>, string]> = [
  ['handoff and idle', { handoff: true }, 'done'],
  ['handoff and process gone', { handoff: true, alive: false }, 'done'],
  ['gone without handoff', { alive: false }, 'exited'],
  ['no pane', { hasPane: false }, 'cant-reach'],
  ['shell mode', { status: 'shell' }, 'in-shell-mode'],
  ['busy and growing', { status: 'busy', msSinceGrowth: 30_000 }, 'busy'],
  ['busy and stalled', { status: 'busy', msSinceGrowth: MAY_NEED_YOU_AFTER_MS + 1000 }, 'may-need-you'],
  ['idle without handoff', {}, 'idle-no-handoff'],
  ['handoff while still busy', { status: 'busy', handoff: true }, 'busy'],
  ['unknown status', { status: 'unknown' }, 'idle-no-handoff']
]
for (const [name, over, want] of cases) {
  test(`classify: ${name}`, () => assert.equal(classify({ ...base, ...over }), want))
}

test('may need you threshold is two minutes', () => assert.equal(MAY_NEED_YOU_AFTER_MS, 120_000))

test('straggler states exclude done, closing and closed', () => {
  for (const s of ['done', 'closing', 'closed'] as const) assert.equal(STRAGGLER_STATES.has(s), false)
  for (const s of ['busy', 'may-need-you', 'idle-no-handoff', 'in-shell-mode', 'cant-reach', 'exited', 'exit-failed'] as const) assert.equal(STRAGGLER_STATES.has(s), true)
})

test('a permission prompt (status waiting) is its own straggler state', () => {
  assert.equal(classify({ ...base, status: 'waiting' }), 'waiting-on-you')
  assert.equal(STRAGGLER_STATES.has('waiting-on-you'), true)
})

test('final states', async () => {
  const { FINAL_STATES } = await import('../src/pause/state.ts')
  assert.deepEqual([...FINAL_STATES].sort(), ['closed', 'done', 'exit-failed', 'exited'])
})
