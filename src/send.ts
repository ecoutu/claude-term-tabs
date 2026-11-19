import type { Front } from './foreground.ts'
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

/** Type `text` into each target that can safely take it; the others are skipped with a warning. */
export function sendToEach (targets: Candidate[], text: string, deps: SendDeps): SendResult[] {
  return targets.map(cand => ({ cand, sent: typeInto(cand, deps.adapter, text, deps.warn, deps.inFront) }))
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
