import type { Config } from './config.ts'
import { isResumableDir, resumeCommand } from './history.ts'
import type { Snapshot, SnapshotSession } from './snapshot.ts'
import type { TerminalAdapter } from './terminals/adapter.ts'
import { shellQuote } from './shell.ts'

/** What `ct resume` will do with one recorded session. */
export interface ResumeStep {
  session: SnapshotSession
  action: 'open' | 'skip-live' | 'skip-dir-gone'
  command: string
  newWindow: boolean
}

/** Order recorded sessions by window then tab and decide, for each, whether to open it. */
export function planResume (snap: Snapshot, liveIds: Set<string>, dirExists: (p: string) => boolean, config: Config, opts: { noPrompt: boolean }): ResumeStep[] {
  const ordered = [...snap.sessions].sort((a, b) => position(a.windowIndex) - position(b.windowIndex) || position(a.tabIndex) - position(b.tabIndex))
  const windowsOpened = new Set<string>()
  return ordered.map(session => {
    const base = resumeCommand(config, session.sessionId)
    const command = opts.noPrompt ? base : `${base} ${shellQuote(config.resumePrompt)}`
    if (liveIds.has(session.sessionId)) return { session, action: 'skip-live', command, newWindow: false }
    if (!isResumableDir(session.cwd, dirExists)) return { session, action: 'skip-dir-gone', command, newWindow: false }
    const group = String(session.windowIndex ?? 'none')
    const newWindow = !windowsOpened.has(group)
    windowsOpened.add(group)
    return { session, action: 'open', command, newWindow }
  })
}

/** Carry out a resume plan. Returns 1 when there is no terminal to open tabs in, or a tab failed to open. */
export function runResume (steps: ResumeStep[], adapter: TerminalAdapter | undefined, opts: { dryRun: boolean }, write: (s: string) => void): number {
  const shell = (s: ResumeStep) => `cd ${shellQuote(s.session.cwd)} && ${s.command}`
  if (adapter === undefined && !opts.dryRun) {
    write('No supported terminal to open tabs in; run these yourself:')
    for (const s of steps.filter(x => x.action === 'open')) write(`  ${shell(s)}`)
    return 1
  }
  let opened = 0
  let failed = false
  for (const s of steps) {
    const name = `${s.session.title ?? s.session.sessionId} · ${s.session.repo}`
    if (s.action === 'skip-live') {
      write(`  ${name} · already running`)
      continue
    }
    if (s.action === 'skip-dir-gone') {
      write(`  ${name} · ${s.session.cwd} no longer exists, not resumed\n    ${shell(s)}`)
      continue
    }
    if (opts.dryRun) {
      write(`  ${shell(s)}${s.newWindow ? '   (new window)' : ''}`)
      continue
    }
    try {
      adapter?.openPane(s.session.cwd, s.command, { newWindow: s.newWindow })
      opened++
      write(`→ ${name}`)
    } catch (err) {
      failed = true
      write(`✗ ${name}: ${(err as Error).message}`)
    }
  }
  if (!opts.dryRun) write(`Resumed ${opened} of ${steps.length} sessions.`)
  return failed ? 1 : 0
}

function position (n: number | undefined): number {
  return n ?? Number.MAX_SAFE_INTEGER
}
