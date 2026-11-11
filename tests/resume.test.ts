import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { DEFAULT_RESUME_PROMPT, DEFAULT_STOP_PROMPT, type Config } from '../src/config.ts'
import { planResume, runResume } from '../src/resume.ts'
import type { Snapshot, SnapshotSession } from '../src/snapshot.ts'
import type { TerminalAdapter } from '../src/terminals/adapter.ts'

const s = (id: string, windowIndex?: number, tabIndex?: number): SnapshotSession =>
  ({ sessionId: id, cwd: `/w/${id}`, repo: id, windowIndex, tabIndex, handoffWritten: true })
const snap: Snapshot = { id: 'x', createdAt: '', sessions: [s('b2', 2, 2), s('a1', 1, 1), s('none'), s('b1', 2, 1), s('a2', 1, 2)] }
const config: Config = { stopPrompt: DEFAULT_STOP_PROMPT, resumePrompt: 'Say "hi" to $HOME\nit\'s fine', pauseTimeoutMinutes: 10, excludeDirs: [] }
const exists = () => true

test('steps follow window then tab order, missing positions last, with one new window per group', () => {
  const steps = planResume(snap, new Set(), exists, config, { noPrompt: false })
  assert.deepEqual(steps.map(x => [x.session.sessionId, x.newWindow]), [['a1', true], ['a2', false], ['b1', true], ['b2', false], ['none', true]])
})

test('live and dir-gone sessions are skipped and the next open in that window gets the new window', () => {
  const steps = planResume(snap, new Set(['a1']), p => !p.endsWith('b1'), config, { noPrompt: false })
  assert.deepEqual(steps.map(x => [x.session.sessionId, x.action, x.newWindow]), [
    ['a1', 'skip-live', false], ['a2', 'open', true], ['b1', 'skip-dir-gone', false], ['b2', 'open', true], ['none', 'open', true]
  ])
  assert.match(steps[2].command, /claude --resume b1/)
})

test('the prompt survives the shell intact', () => {
  const steps = planResume({ ...snap, sessions: [s('a1', 1, 1)] }, new Set(), exists, { ...config, resumeCommand: "printf '%s|' {id}" }, { noPrompt: false })
  const out = spawnSync('sh', ['-c', steps[0].command], { encoding: 'utf8' }).stdout
  assert.equal(out, `a1|${config.resumePrompt}|`)
})

test('--no-prompt leaves the prompt off', () =>
  assert.equal(planResume({ ...snap, sessions: [s('a1', 1, 1)] }, new Set(), exists, config, { noPrompt: true })[0].command, 'claude --resume a1'))

test('the default prompt is used when none is configured', () =>
  assert.ok(planResume({ ...snap, sessions: [s('a1', 1, 1)] }, new Set(), exists, { ...config, resumePrompt: DEFAULT_RESUME_PROMPT }, { noPrompt: false })[0].command.includes('Resumed after a machine restart')))

function fakeAdapter () {
  const opened: Array<[string, string, boolean]> = []
  const adapter: TerminalAdapter = {
    name: 'iterm2', listPanes: () => [], focus: () => {}, sendText: () => {}, closePane: () => {},
    openPane: (cwd, cmd, opts) => { opened.push([cwd, cmd, opts?.newWindow === true]); return 'id' }
  }
  return { adapter, opened }
}

test('run opens each open step and reports skips', () => {
  const { adapter, opened } = fakeAdapter()
  const out: string[] = []
  const steps = planResume(snap, new Set(['a1']), exists, config, { noPrompt: true })
  assert.equal(runResume(steps, adapter, { dryRun: false }, l => out.push(l)), 0)
  assert.deepEqual(opened.map(o => [o[0], o[2]]), [['/w/a2', true], ['/w/b1', true], ['/w/b2', false], ['/w/none', true]])
  assert.match(out.join('\n'), /already running/)
  assert.match(out.join('\n'), /Resumed 4 of 5 sessions/)
})

test('dry run opens nothing and prints the commands', () => {
  const { adapter, opened } = fakeAdapter()
  const out: string[] = []
  runResume(planResume(snap, new Set(), exists, config, { noPrompt: true }), adapter, { dryRun: true }, l => out.push(l))
  assert.equal(opened.length, 0)
  assert.match(out.join('\n'), /cd '\/w\/a1' && claude --resume a1/)
})

test('no adapter prints the commands and returns 1', () => {
  const out: string[] = []
  assert.equal(runResume(planResume(snap, new Set(), exists, config, { noPrompt: true }), undefined, { dryRun: false }, l => out.push(l)), 1)
  assert.match(out.join("\n"), /No supported terminal/)
})

test('resuming when everything is live opens nothing', () => {
  const { adapter, opened } = fakeAdapter()
  const all = new Set(snap.sessions.map(x => x.sessionId))
  runResume(planResume(snap, all, exists, config, { noPrompt: false }), adapter, { dryRun: false }, () => {})
  assert.equal(opened.length, 0)
})
