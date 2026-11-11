import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fzfArgs, fzfEnv, reloadAction, runStragglerUi, POLL_MS } from '../src/pause/ui.ts'
import type { PauseDeps, PauseRun, Tracked } from '../src/pause/run.ts'
import { DEFAULT_RESUME_PROMPT } from '../src/config.ts'

test('fzf args listen locally, jump on enter and double-click, and re-send on ctrl-r', () => {
  const args = fzfArgs(4321, ["/usr/bin/node", "/x/it's/ctt"])
  const joined = args.join(' ')
  assert.ok(args.includes('--listen') && args[args.indexOf('--listen') + 1] === '127.0.0.1:4321')
  assert.ok(joined.includes("enter:execute-silent('/usr/bin/node' '/x/it'\\''s/ctt' _focus {1})"))
  assert.ok(joined.includes("double-click:execute-silent('/usr/bin/node' '/x/it'\\''s/ctt' _focus {1})"))
  assert.ok(joined.includes("ctrl-r:execute-silent('/usr/bin/node' '/x/it'\\''s/ctt' _send-stop {1})"))
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
  const deps: PauseDeps = {
    now: () => clock,
    collect: () => [],
    isAlive: () => true,
    transcriptOf: () => '/nope',
    sizeOf: () => 0,
    snapshotDir: '/nope',
    config: { stopPrompt: 's', resumePrompt: DEFAULT_RESUME_PROMPT, pauseTimeoutMinutes: 10, excludeDirs: [] },
    warn: () => {},
    inFront: () => 'claude'
  }
  const run: PauseRun = { startedAt: 0, autoClose: false, snapshot: { id: 'x', createdAt: '', sessions: [] }, tracked: states[0].map((s, i) => tracked(`s${i}`, s)) }
  const advance = (r: PauseRun): PauseRun => {
    tick = Math.min(tick + 1, states.length - 1)
    return { ...r, tracked: states[tick].map((s, i) => tracked(`s${i}`, s)) }
  }
  const writes: string[] = []
  const io = { hasFzf: false, isTty: false, timeoutMs: 60_000, self: ['node', 'ctt'], write: (s: string) => { writes.push(s) }, sleep: async (ms: number) => { clock += ms } }
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

test('reload action carries only a ctt-chosen file path, never list data', () => {
  assert.equal(reloadAction('/tmp/ctt-abc/lines'), "reload(cat '/tmp/ctt-abc/lines')")
  assert.throws(() => reloadAction('/tmp/x)+execute(rm)/lines'), /unsafe/)
})

test('fzf gets a random API key in its environment', () => {
  const a = fzfEnv({ PATH: '/bin' })
  const b = fzfEnv({ PATH: '/bin' })
  assert.equal(a.PATH, '/bin')
  assert.match(a.FZF_API_KEY ?? '', /^[0-9a-f]{64}$/)
  assert.notEqual(a.FZF_API_KEY, b.FZF_API_KEY)
})

test('a tick that throws warns and the loop keeps going', async () => {
  const s = sim([['busy'], ['busy'], ['done']])
  const warnings: string[] = []
  s.deps.warn = m => { warnings.push(m) }
  let calls = 0
  const flaky = (r: PauseRun): PauseRun => { calls++; if (calls === 1) throw new Error('ps failed'); return s.advance(r) }
  const end = await runStragglerUi(s.run, s.deps, s.io, flaky)
  assert.equal(end.tracked[0].state, 'done')
  assert.match(warnings.join('\n'), /ps failed/)
})

test('the loop ends once only final states remain', async () => {
  const s = sim([['busy', 'busy'], ['exited', 'done']])
  s.io.timeoutMs = POLL_MS * 100
  await runStragglerUi(s.run, s.deps, s.io, s.advance)
  assert.ok(s.clock() <= POLL_MS * 2)
})
