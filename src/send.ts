import type { Front } from './foreground.ts'
import type { LlmMatch } from './llm.ts'
import { rankLocal, tokenize } from './score.ts'
import type { TerminalAdapter } from './terminals/adapter.ts'
import { typeInto } from './type-into.ts'
import type { Candidate } from './types.ts'

/** What `ctt send` needs to type into sessions; injected so tests can fake it. */
export interface SendDeps {
  adapter?: TerminalAdapter
  warn: (m: string) => void
  inFront: (c: Candidate) => Front
}

/** The outcome for one target session. */
export interface SendResult { cand: Candidate, sent: boolean }

/** Live sessions a query picks, best match first; a query with no real words picks them all. */
export function sendTargets (query: string, live: Candidate[], now: number): Candidate[] {
  return tokenize(query).length === 0 ? live : rankLocal(query, live, now).map(r => r.cand)
}

/**
 * The sessions a send offers: Haiku's matches first, then local ones. A session only Haiku chose is labelled
 * "Haiku:", and rows start marked only when a query narrowed the list and every row matched its words.
 */
export function sendChoices (live: Candidate[], local: Candidate[], haiku: LlmMatch[] | undefined, narrowed: boolean): { cands: Candidate[], summaries: Map<string, string>, preselect: boolean } {
  const byId = new Map(live.map(c => [c.digest.sessionId, c]))
  const localIds = new Set(local.map(c => c.digest.sessionId))
  const fromHaiku = (haiku ?? []).flatMap(m => byId.get(m.sessionId) ?? [])
  const seen = new Set(fromHaiku.map(c => c.digest.sessionId))
  return {
    cands: [...fromHaiku, ...local.filter(c => !seen.has(c.digest.sessionId))],
    summaries: new Map((haiku ?? []).map(m => [m.sessionId, localIds.has(m.sessionId) ? m.summary : `Haiku: ${m.summary}`])),
    preselect: narrowed && fromHaiku.every(c => localIds.has(c.digest.sessionId))
  }
}

/**
 * Type `text` into each target that can safely take it, judged by its state in `current` (the sessions running
 * now) rather than when it was chosen. Targets no longer running, and the others refused, are skipped with a warning.
 */
export function sendToEach (targets: Candidate[], current: Candidate[], text: string, deps: SendDeps): SendResult[] {
  const now = new Map(current.map(c => [c.digest.sessionId, c]))
  return targets.map(cand => {
    const latest = now.get(cand.digest.sessionId)
    if (latest === undefined) {
      deps.warn(`claude-term-tabs: ${cand.digest.title ?? cand.digest.sessionId} is no longer running; not typing into it`)
      return { cand, sent: false }
    }
    return { cand: latest, sent: typeInto(latest, deps.adapter, text, deps.warn, deps.inFront) }
  })
}

/** One line per session typed into, then the count; exit 0 only when every target got the message. */
export function sendSummary (results: SendResult[]): { lines: string[], exitCode: number } {
  const sent = results.filter(r => r.sent)
  const noun = results.length === 1 ? 'session' : 'sessions'
  return {
    lines: [...sent.map(r => `→ ${label(r.cand)}`), `Sent to ${sent.length} of ${results.length} ${noun}.`],
    exitCode: sent.length === results.length ? 0 : 1
  }
}

function label (c: Candidate): string {
  return [c.digest.title ?? c.digest.sessionId, c.digest.repo].join(' · ')
}
