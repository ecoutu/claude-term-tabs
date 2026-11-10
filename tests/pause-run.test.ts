import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RESUME_PROMPT } from '../src/config.ts'
import { pauseSummary, sendStop, startPause, stragglerLines, tickPause, type PauseDeps } from '../src/pause/run.ts'
import type { TerminalAdapter } from '../src/terminals/adapter.ts'
import type { Candidate, Pane, Status } from '../src/types.ts'

const START = Date.parse('2026-11-10T20:00:00Z')

interface Sim { id: string, status: Status, alive: boolean, pane: boolean }

function world (sims: Sim[], autoCloseOpts: { autoClose: boolean } = { autoClose: false }) {
  const root = mkdtempSync(join(tmpdir(), 'ct-pause-'))
  const log: string[] = []
  let clock = START
  const state = new Map(sims.map(s => [s.id, { ...s }]))
  const transcript = (id: string) => join(root, `${id}.jsonl`)
  for (const s of sims) writeFileSync(transcript(s.id), JSON.stringify({ type: 'assistant', timestamp: '2026-11-09T10:00:00Z', message: { content: [{ type: 'text', text: 'HANDOFF\n- old one' }] } }) + '\n')
  const pane = (id: string): Pane => ({ id: `pane-${id}`, tty: `/dev/${id}`, title: id, windowId: 'w', windowIndex: 1, tabIndex: sims.findIndex(s => s.id === id) + 1 })
  const cand = (s: Sim, i: number): Candidate => ({
    live: true, status: s.status, pid: 100 + i, tty: `/dev/${s.id}`, pane: s.pane ? pane(s.id) : undefined,
    digest: { sessionId: s.id, cwd: `/w/${s.id}`, repo: s.id, title: `Title ${s.id}`, lastActive: START }
  })
  const adapter: TerminalAdapter = {
    name: 'iterm2',
    listPanes: () => [],
    focus: () => {},
    sendText: (p, text) => { log.push(`send ${p.id} ${text.slice(0, 12)}`) },
    closePane: p => { log.push(`close ${p.id}`) },
    openPane: () => 'x'
  }
  const deps: PauseDeps = {
    now: () => clock,
    adapter,
    collect: () => sims.map((s, i) => [state.get(s.id)!, i] as const).filter(([s]) => s.alive).map(([s, i]) => cand(s, i)),
    isAlive: pid => state.get(sims[pid - 100].id)!.alive,
    transcriptOf: c => transcript(c.digest.sessionId),
    sizeOf: p => statSync(p).size,
    snapshotDir: join(root, 'snapshots'),
    config: { stopPrompt: 'STOP-PROMPT now', resumePrompt: DEFAULT_RESUME_PROMPT, pauseTimeoutMinutes: 10 },
    warn: m => { log.push(`warn ${m}`) },
    onSnapshot: () => { log.push('snapshot') }
  }
  const handoff = (id: string, at = clock) => appendFileSync(transcript(id), JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'text', text: 'Stopped.\nHANDOFF\n- Goal: x' }] } }) + '\n')
  const grow = (id: string) => appendFileSync(transcript(id), JSON.stringify({ type: 'progress' }) + '\n')
  return {
    deps, log, root, handoff, grow,
    set: (id: string, over: Partial<Sim>) => { Object.assign(state.get(id)!, over) },
    advance: (ms: number) => { clock += ms },
    start: () => startPause(deps, autoCloseOpts)
  }
}

const stateOf = (run: ReturnType<typeof startPause>, id: string) => run.tracked.find(t => t.cand.digest.sessionId === id)?.state

test('snapshot is saved before anything is typed', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }])
  w.start()
  assert.deepEqual(w.log.slice(0, 2), ['snapshot', 'send pane-a STOP-PROMPT '])
  assert.equal(readdirSync(join(w.root, 'snapshots')).length, 1)
})

test('stop prompt goes to idle and busy sessions only', () => {
  const w = world([
    { id: 'idle', status: 'idle', alive: true, pane: true },
    { id: 'busy', status: 'busy', alive: true, pane: true },
    { id: 'shell', status: 'shell', alive: true, pane: true },
    { id: 'nopane', status: 'idle', alive: true, pane: false }
  ])
  const run = w.start()
  assert.deepEqual(w.log.filter(l => l.startsWith('send')).map(l => l.split(' ')[1]), ['pane-idle', 'pane-busy'])
  assert.equal(stateOf(run, 'shell'), 'in-shell-mode')
  assert.equal(stateOf(run, 'nopane'), 'cant-reach')
})

test('a fresh HANDOFF on an idle session is done; an old one is not', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }, { id: 'b', status: 'idle', alive: true, pane: true }])
  let run = w.start()
  w.advance(5000)
  w.handoff('a')
  run = tickPause(run, w.deps)
  assert.equal(stateOf(run, 'a'), 'done')
  assert.equal(stateOf(run, 'b'), 'idle-no-handoff')
})

test('auto-close exits a done session, then closes its pane once the process is gone', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }], { autoClose: true })
  let run = w.start()
  w.advance(3000)
  w.handoff('a')
  run = tickPause(run, w.deps)
  assert.equal(stateOf(run, 'a'), 'closing')
  assert.equal(w.log.filter(l => l === 'send pane-a /exit').length, 1)
  run = tickPause(run, w.deps)
  assert.equal(w.log.filter(l => l === 'send pane-a /exit').length, 1)
  w.set('a', { alive: false })
  run = tickPause(run, w.deps)
  assert.equal(stateOf(run, 'a'), 'closed')
  assert.ok(w.log.includes('close pane-a'))
})

test('auto-close gives up after 10 s and never closes a live process', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }], { autoClose: true })
  let run = w.start()
  w.handoff('a')
  run = tickPause(run, w.deps)
  w.advance(10_001)
  run = tickPause(run, w.deps)
  assert.equal(stateOf(run, 'a'), 'exit-failed')
  assert.ok(!w.log.some(l => l.startsWith('close')))
})

test('auto-close never touches a done session that is not idle', () => {
  const w = world([{ id: 'a', status: 'shell', alive: true, pane: true }], { autoClose: true })
  let run = w.start()
  w.handoff('a')
  run = tickPause(run, w.deps)
  assert.equal(stateOf(run, 'a'), 'done')
  assert.ok(!w.log.some(l => l.includes('/exit') || l.startsWith('close')))
})

test('without auto-close nothing is ever exited or closed', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }])
  let run = w.start()
  w.handoff('a')
  run = tickPause(run, w.deps)
  w.advance(60_000)
  tickPause(run, w.deps)
  assert.ok(!w.log.some(l => l.includes('/exit') || l.startsWith('close')))
})

test('stragglers are never exited or closed, whatever the clock says', () => {
  const w = world([{ id: 'a', status: 'busy', alive: true, pane: true }], { autoClose: true })
  let run = w.start()
  for (let i = 0; i < 5; i++) { w.advance(600_000); run = tickPause(run, w.deps) }
  assert.equal(stateOf(run, 'a'), 'may-need-you')
  assert.ok(!w.log.some(l => l.includes('/exit') || l.startsWith('close')))
})

test('busy with transcript growth stays busy', () => {
  const w = world([{ id: 'a', status: 'busy', alive: true, pane: true }])
  let run = w.start()
  for (let i = 0; i < 5; i++) { w.advance(60_000); w.grow('a'); run = tickPause(run, w.deps) }
  assert.equal(stateOf(run, 'a'), 'busy')
})

test('a session that disappears without a HANDOFF is exited', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }])
  let run = w.start()
  w.set('a', { alive: false })
  run = tickPause(run, w.deps)
  assert.equal(stateOf(run, 'a'), 'exited')
})

test('the snapshot records handoffWritten once a session is done', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }])
  let run = w.start()
  w.handoff('a')
  run = tickPause(run, w.deps)
  const file = join(w.root, 'snapshots', readdirSync(join(w.root, 'snapshots'))[0])
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions[0].handoffWritten, true)
})

test('straggler lines carry id, labels, duration and tab', () => {
  const w = world([
    { id: 'a', status: 'shell', alive: true, pane: true },
    { id: 'b', status: 'idle', alive: true, pane: true },
    { id: 'c', status: 'idle', alive: true, pane: true }
  ])
  let run = w.start()
  w.handoff('c')
  w.advance(5 * 60_000)
  run = tickPause(run, w.deps)
  assert.deepEqual(stragglerLines(run, START + 5 * 60_000), [
    'a\tTitle a · a · in shell mode · 5m · tab 1',
    'b\tTitle b · b · idle, no HANDOFF · 5m · tab 2'
  ])
})

test('summary says safe to restart only when nothing is left', () => {
  const w = world([{ id: 'a', status: 'idle', alive: true, pane: true }, { id: 'b', status: 'idle', alive: true, pane: true }])
  let run = w.start()
  w.handoff('a')
  run = tickPause(run, w.deps)
  const partial = pauseSummary(run)
  assert.equal(partial.exitCode, 1)
  assert.match(partial.text, /1 sessions have no HANDOFF; they are still recorded\./)
  assert.match(partial.text, /Title b · b · idle, no HANDOFF/)
  w.handoff('b')
  run = tickPause(run, w.deps)
  const done = pauseSummary(run)
  assert.equal(done.exitCode, 0)
  assert.match(done.text, /Safe to restart\.$/)
})

test('sendStop refuses a session in shell mode', () => {
  const w = world([{ id: 'a', status: 'shell', alive: true, pane: true }])
  const c = w.deps.collect()[0]
  assert.equal(sendStop(c, w.deps.adapter, 'STOP', w.deps.warn), false)
  assert.ok(w.log.some(l => l.startsWith('warn') && l.includes('shell')))
  assert.ok(!w.log.some(l => l.startsWith('send')))
})
