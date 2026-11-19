import type { Front } from './foreground.ts'
import type { TerminalAdapter } from './terminals/adapter.ts'
import type { Candidate } from './types.ts'

/** Statuses whose prompt accepts typed text; Claude Code queues what is typed while busy. */
export const TYPEABLE: ReadonlySet<string> = new Set(['idle', 'busy'])

/** Type `text` into one session. Refuses (and warns) unless it is idle or busy, reachable, and Claude is in front. */
export function typeInto (cand: Candidate, adapter: TerminalAdapter | undefined, text: string, warn: (m: string) => void, inFront: (c: Candidate) => Front): boolean {
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
    adapter.sendText(cand.pane, text)
    return true
  } catch (err) {
    warn(`claude-term-tabs: could not type into ${name}: ${(err as Error).message}`)
    return false
  }
}
