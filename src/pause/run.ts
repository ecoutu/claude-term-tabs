import type { Config } from '../config.ts'
import type { Front } from '../foreground.ts'
import { hasHandoff, latestAssistantAfterPrompt } from '../handoff.ts'
import { cleanField, formatAge } from '../picker.ts'
import { pruneSnapshots, saveSnapshot, snapshotFrom, type Snapshot } from '../snapshot.ts'
import type { TerminalAdapter } from '../terminals/adapter.ts'
import type { Candidate } from '../types.ts'
import { classify, STRAGGLER_STATES, type PauseState } from './state.ts'

/** How long `/exit` gets before a session is marked exit-failed. */
export const EXIT_GRACE_MS = 10_000
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const EXIT_COMMAND = '/exit'
const PROMPT_START_CHARS = 60
const TYPEABLE: ReadonlySet<string> = new Set(['idle', 'busy'])

const LABELS: Readonly<Record<PauseState, string>> = {
  done: 'done',
  closing: 'closing',
  closed: 'closed',
  'exit-failed': 'exit failed',
  busy: 'busy',
  'may-need-you': 'may need you',
  'waiting-on-you': 'waiting on you',
  'idle-no-handoff': 'idle, no HANDOFF',
  'in-shell-mode': 'in shell mode',
  'cant-reach': "can't reach",
  exited: 'exited'
}

/** One session followed by a pause. */
export interface Tracked {
  cand: Candidate
  state: PauseState
  since: number
  lastSize: number
  lastGrowth: number
  closeRequestedAt?: number
}

/** The whole pause at one point in time. */
export interface PauseRun { startedAt: number, snapshot: Snapshot, tracked: Tracked[], autoClose: boolean }

/** Side effects a pause needs; injected so tests can fake them. */
export interface PauseDeps {
  now: () => number
  adapter?: TerminalAdapter
  collect: () => Candidate[]
  isAlive: (pid: number) => boolean
  transcriptOf: (c: Candidate) => string
  sizeOf: (path: string) => number
  snapshotDir: string
  config: Config
  warn: (m: string) => void
  onSnapshot?: (path: string) => void
  inFront: (c: Candidate) => Front
}

/** Snapshot every live session, then type the stop prompt into each one that can take it. */
export function startPause (deps: PauseDeps, opts: { autoClose: boolean }): PauseRun {
  const now = deps.now()
  const cands = deps.collect()
  pruneSnapshots(deps.snapshotDir, now, SNAPSHOT_MAX_AGE_MS)
  const snapshot = snapshotFrom(cands, deps.adapter?.name, now)
  deps.onSnapshot?.(saveSnapshot(deps.snapshotDir, snapshot))
  const tracked = cands.map(cand => {
    const typeable = TYPEABLE.has(cand.status)
    const sent = typeable && sendStop(cand, deps.adapter, deps.config.stopPrompt, deps.warn, deps.inFront)
    const size = safeSize(deps, deps.transcriptOf(cand))
    const classified = classify({ alive: true, status: cand.status, hasPane: canType(cand, deps.adapter), handoff: false, msSinceGrowth: 0 })
    const state: PauseState = typeable && !sent ? 'cant-reach' : classified
    return { cand, state, since: now, lastSize: size, lastGrowth: now }
  })
  return { startedAt: now, snapshot, tracked, autoClose: opts.autoClose }
}

/** Advance every session one step: refresh facts, classify, and run auto-close. Returns a new run. */
export function tickPause (run: PauseRun, deps: PauseDeps): PauseRun {
  const now = deps.now()
  const live = new Map(deps.collect().map(c => [c.digest.sessionId, c]))
  const tracked = run.tracked.map(t => step(t, live.get(t.cand.digest.sessionId), run, deps, now))
  const newlyDone = tracked.filter((t, i) => isDone(t.state) && !isDone(run.tracked[i].state))
  if (newlyDone.length === 0) return { ...run, tracked }
  const doneIds = new Set(tracked.filter(t => isDone(t.state)).map(t => t.cand.digest.sessionId))
  const snapshot = { ...run.snapshot, sessions: run.snapshot.sessions.map(s => ({ ...s, handoffWritten: doneIds.has(s.sessionId) })) }
  deps.onSnapshot?.(saveSnapshot(deps.snapshotDir, snapshot))
  return { ...run, snapshot, tracked }
}

/** Type the stop prompt into one session. Refuses (and warns) unless it is idle or busy, reachable, and Claude is in front. */
export function sendStop (cand: Candidate, adapter: TerminalAdapter | undefined, prompt: string, warn: (m: string) => void, inFront: (c: Candidate) => Front): boolean {
  const name = cand.digest.title ?? cand.digest.sessionId
  if (cand.status === 'shell') {
    warn(`claude-term-tabs: ${name} is in shell mode; not typing into it`)
    return false
  }
  if (!TYPEABLE.has(cand.status)) {
    warn(`claude-term-tabs: ${name} is ${cand.status === 'waiting' ? 'waiting on a prompt' : `in status ${cand.status}`}; not typing into it`)
    return false
  }
  if (adapter === undefined || cand.pane === undefined) {
    warn(`claude-term-tabs: ${name} is not in a supported terminal pane`)
    return false
  }
  if (inFront(cand) !== 'claude') {
    warn(`claude-term-tabs: Claude is not in front of the tab for ${name}; not typing into it`)
    return false
  }
  try {
    adapter.sendText(cand.pane, prompt)
    return true
  } catch (err) {
    warn(`claude-term-tabs: could not type into ${name}: ${(err as Error).message}`)
    return false
  }
}

/** Picker-style lines for sessions still in a straggler state. */
export function stragglerLines (run: PauseRun, now: number): string[] {
  return run.tracked.filter(t => STRAGGLER_STATES.has(t.state)).map(t => {
    const d = t.cand.digest
    const fields = [d.title ?? '(untitled)', d.repo, LABELS[t.state], formatAge(t.since, now), t.cand.pane !== undefined ? `tab ${t.cand.pane.tabIndex}` : undefined]
    return `${d.sessionId}\t${fields.filter((f): f is string => f !== undefined).map(cleanField).join(' · ')}`
  })
}

/** Final report and exit code: 0 only when every session finished. */
export function pauseSummary (run: PauseRun): { text: string, exitCode: number } {
  const total = run.tracked.length
  const done = run.tracked.filter(t => isDone(t.state)).length
  const closed = run.tracked.filter(t => t.state === 'closed').length
  const short = (t: Tracked) => [t.cand.digest.title ?? t.cand.digest.sessionId, t.cand.digest.repo, LABELS[t.state]].map(cleanField).join(' · ')
  const left = run.tracked.filter(t => STRAGGLER_STATES.has(t.state) && t.state !== 'exit-failed').map(short)
  const unclosed = run.tracked.filter(t => t.state === 'exit-failed').map(short)
  const head = `${done} of ${total} sessions wrote a HANDOFF${run.autoClose ? `, ${closed} closed` : ''}.`
  const failedLines = unclosed.length > 0 ? [`${unclosed.length} sessions could not be closed; close them yourself:`, ...unclosed.map(l => `  - ${l}`)] : []
  if (left.length === 0) return { text: [head, ...failedLines, 'Safe to restart.'].join('\n'), exitCode: 0 }
  return {
    text: [head, ...failedLines, ...left.map(l => `  - ${l}`), `${left.length} sessions have no HANDOFF; they are still recorded.`].join('\n'),
    exitCode: 1
  }
}

function step (t: Tracked, cur: Candidate | undefined, run: PauseRun, deps: PauseDeps, now: number): Tracked {
  if (t.state === 'closed' || t.state === 'exit-failed') return t
  if (t.state === 'closing') return stepClosing(t, deps, now)
  const cand = cur ?? t.cand
  const path = deps.transcriptOf(cand)
  const size = safeSize(deps, path)
  const lastGrowth = size !== t.lastSize ? now : t.lastGrowth
  const alive = cur !== undefined
  const handoff = hasHandoff(latestAssistantAfterPrompt(path, promptStart(deps.config.stopPrompt), run.startedAt))
  const state = classify({ alive, status: cand.status, hasPane: canType(cand, deps.adapter), handoff, msSinceGrowth: now - lastGrowth })
  const next: Tracked = { ...t, cand, state, since: state === t.state ? t.since : now, lastSize: size, lastGrowth }
  if (state !== 'done' || !run.autoClose || !alive || cand.status !== 'idle' || !canType(cand, deps.adapter) || deps.inFront(cand) !== 'claude') return next
  try {
    deps.adapter?.sendText(cand.pane as NonNullable<Candidate['pane']>, EXIT_COMMAND)
    return { ...next, state: 'closing', since: now, closeRequestedAt: now }
  } catch (err) {
    deps.warn(`claude-term-tabs: could not exit ${cand.digest.title ?? cand.digest.sessionId}: ${(err as Error).message}`)
    return next
  }
}

function stepClosing (t: Tracked, deps: PauseDeps, now: number): Tracked {
  const pid = t.cand.pid
  if (pid !== undefined && !deps.isAlive(pid)) {
    if (deps.inFront(t.cand) !== 'shell') {
      deps.warn(`claude-term-tabs: ${t.cand.digest.title ?? t.cand.digest.sessionId} exited, but something other than its shell is in front; leaving the tab open`)
      return { ...t, state: 'done', since: now }
    }
    try {
      if (t.cand.pane !== undefined) deps.adapter?.closePane(t.cand.pane)
    } catch (err) {
      deps.warn(`claude-term-tabs: could not close the tab for ${t.cand.digest.title ?? t.cand.digest.sessionId}: ${(err as Error).message}`)
    }
    return { ...t, state: 'closed', since: now }
  }
  if (now - (t.closeRequestedAt ?? now) > EXIT_GRACE_MS) return { ...t, state: 'exit-failed', since: now }
  return t
}

function isDone (s: PauseState): boolean {
  return s === 'done' || s === 'closing' || s === 'closed' || s === 'exit-failed'
}

function promptStart (prompt: string): string {
  return prompt.trimStart().split('\n')[0].slice(0, PROMPT_START_CHARS)
}

function canType (c: Candidate, adapter: TerminalAdapter | undefined): boolean {
  return adapter !== undefined && c.pane !== undefined
}

function safeSize (deps: PauseDeps, path: string): number {
  try {
    return deps.sizeOf(path)
  } catch {
    return -1
  }
}
