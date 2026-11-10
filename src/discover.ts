import { DigestCache } from './cache.ts'
import type { Deps } from './cli.ts'
import { collectLiveSessions } from './live.ts'
import type { TerminalAdapter } from './terminals/adapter.ts'
import type { Candidate, Pane } from './types.ts'

/** Live sessions with their panes attached; a pane listing failure warns and attaches none. */
export function liveWithPanes (deps: Deps, adapter: TerminalAdapter | undefined): Candidate[] {
  const cache = DigestCache.load(deps.dirs.cache, deps.stderr)
  const panes = listPanesOrWarn(adapter, deps)
  const byTty = new Map(panes.map(p => [p.tty, p]))
  const live = collectLiveSessions({ sessionsDir: deps.dirs.sessions, projectsDir: deps.dirs.projects, exec: deps.exec, cache })
    .map(c => ({ ...c, pane: c.tty !== undefined ? byTty.get(c.tty) : undefined }))
  try {
    cache.save()
  } catch (err) {
    deps.stderr(`claude-tabs: could not save cache: ${(err as Error).message}`)
  }
  return live
}

/** Panes from the adapter, or none (with a warning) when listing fails. */
export function listPanesOrWarn (adapter: TerminalAdapter | undefined, deps: Deps): Pane[] {
  if (adapter === undefined) return []
  try {
    return adapter.listPanes()
  } catch (err) {
    deps.stderr(`claude-tabs: ${(err as Error).message}`)
    return []
  }
}
