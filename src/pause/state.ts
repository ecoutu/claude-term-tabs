import type { Status } from '../types.ts'

/** Where a session stands during `ct pause`. */
export type PauseState =
  | 'done' | 'closing' | 'closed' | 'exit-failed'
  | 'busy' | 'may-need-you' | 'waiting-on-you' | 'idle-no-handoff' | 'in-shell-mode' | 'cant-reach' | 'exited'

/** Facts about one session at one tick. */
export interface ClassifyInput {
  alive: boolean
  status: Status
  hasPane: boolean
  handoff: boolean
  msSinceGrowth: number
}

/** Busy this long with no transcript growth reads as "may need you" (likely a permission prompt). */
export const MAY_NEED_YOU_AFTER_MS = 120_000

/** States that keep a session in the straggler list. */
export const STRAGGLER_STATES: ReadonlySet<PauseState> = new Set<PauseState>([
  'busy', 'may-need-you', 'waiting-on-you', 'idle-no-handoff', 'in-shell-mode', 'cant-reach', 'exited', 'exit-failed'
])

/** States that no longer change; a pause can stop waiting once every session is in one. */
export const FINAL_STATES: ReadonlySet<PauseState> = new Set<PauseState>(['done', 'closed', 'exited', 'exit-failed'])

/** Classify a session from its facts. Never returns closing, closed or exit-failed; the run sets those. */
export function classify (i: ClassifyInput): PauseState {
  if (i.handoff && (!i.alive || i.status !== 'busy')) return 'done'
  if (!i.alive) return 'exited'
  if (!i.hasPane) return 'cant-reach'
  if (i.status === 'shell') return 'in-shell-mode'
  if (i.status === 'waiting') return 'waiting-on-you'
  if (i.status === 'busy') return i.msSinceGrowth > MAY_NEED_YOU_AFTER_MS ? 'may-need-you' : 'busy'
  return 'idle-no-handoff'
}
