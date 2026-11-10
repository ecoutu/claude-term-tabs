import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fzfArgs, runStragglerUi, POLL_MS } from '../src/pause/ui.ts'
import type { PauseDeps, PauseRun, Tracked } from '../src/pause/run.ts'
import { DEFAULT_RESUME_PROMPT } from '../src/config.ts'

test('fzf args listen locally, jump on enter and double-click, and re-send on ctrl-r', () => {
  const args = fzfArgs(4321, ["/usr/bin/node", "/x/it's/ct"])
  const joined = args.join(' ')
  assert.ok(args.includes('--listen') && args[args.indexOf('--listen') + 1] === '127.0.0.1:4321')
  assert.ok(joined.includes("enter:execute-silent('/usr/bin/node' '/x/it'\\''s/ct' _focus {1})"))
  assert.ok(joined.includes("double-click:execute-silent('/usr/bin/node' '/x/it'\\''s/ct' _focus {1})"))
  assert.ok(joined.includes("ctrl-r:execute-silent('/usr/bin/node' '/x/it'\\''s/ct' _send-stop {1})"))
  assert.equal(args[args.indexOf('--delimiter') + 1], '\t')
  assert.equal(args[args.indexOf('--with-nth') + 1], '2..')
})

const tracked = (id: string, state: Tracked['state']): Tracked => ({
  cand: { live: true, status: 'idle', digest: { sessionId: id, cwd: '/x', repo: 'r', title: `T ${id}`, lastActive: 0 } },
  state, since: 0, lastSize: 0, lastGrowth: 0
})

function sim (states: Array<Array<Tracked['state']>>) {
  let clock = 0
  let tick = 0
  const deps = {
    now: () => clock,
    collect: () => [],
    isAlive: () => true,
    transcriptOf: () => '/nope',
    sizeOf: () => 0,
    snapshotDir: '/nope',
    config: { stopPrompt: 's', resumePrompt: DEFAULT_RESUME_PROMPT, pauseTimeoutMinutes: 10 },
    warn: () => {}
  } satisfies PauseDeps
  const run: PauseRun = { startedAt: 0, autoClose: false, snapshot: { id: 'x', createdAt: '', sessions: [] }, tracked: states[0].map((s, i) => tracked(`s${i}`, s)) }
  const advance = (r: PauseRun): PauseRun => {
    tick = Math.min(tick + 1, states.length - 1)
    return { ...r, tracked: states[tick].map((s, i) => tracked(`s${i}`, s)) }
  }
  const writes: string[] = []
  const io = { hasFzf: false, isTty: false, timeoutMs: 60_000, self: ['node', 'ct'], write: (s: string) => { writes.push(s) }, sleep: async (ms: number) => { clock += ms } }
  return { deps, run, advance, writes, io, ticks: () => tick, clock: () => clock }
}

test('plain list returns once nothing is left and prints only changes when not a TTY', async () => {
  const s = sim([['busy', 'busy'], ['busy', 'done'], ['busy', 'done'], ['done', 'done']])
  const end = await runStragglerUi(s.run, s.deps, s.io, s.advance)
  assert.ok(end.tracked.every(t => t.state === 'done'))
  assert.equal(s.writes.length, 2)
  assert.match(s.writes[0], /T s0.*T s1/s)
})

test('closing sessions keep the loop alive until they finish', async () => {
  const s = sim([['done'], ['closing'], ['closing'], ['closed']])
  await runStragglerUi(s.run, s.deps, s.io, s.advance)
  assert.equal(s.ticks(), 3)
})

test('the timeout ends the loop and returns the latest run', async () => {
  const s = sim([['busy'], ['may-need-you']])
  s.io.timeoutMs = POLL_MS * 4
  const end = await runStragglerUi(s.run, s.deps, s.io, s.advance)
  assert.equal(end.tracked[0].state, 'may-need-you')
  assert.ok(s.clock() >= POLL_MS * 4 && s.clock() <= POLL_MS * 5)
})
