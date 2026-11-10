import type { Exec, Pane } from '../types.ts'
import { iterm2Adapter } from './iterm2.ts'
import { weztermAdapter } from './wezterm.ts'

/** A terminal that can list, focus, type into, close and open panes. */
export interface TerminalAdapter {
  name: 'iterm2' | 'wezterm'
  listPanes(): Pane[]
  focus(pane: Pane): void
  sendText(pane: Pane, text: string): void
  closePane(pane: Pane): void
  /** Opens a pane running `command` in `cwd`; returns the new pane id. */
  openPane(cwd: string, command: string, opts?: { newWindow?: boolean }): string
}

const FACTORIES: Readonly<Record<TerminalAdapter['name'], (exec: Exec) => TerminalAdapter>> = {
  iterm2: iterm2Adapter,
  wezterm: weztermAdapter
}

const BY_TERM_PROGRAM: Readonly<Record<string, TerminalAdapter['name']>> = {
  'iTerm.app': 'iterm2',
  WezTerm: 'wezterm'
}

/**
 * Pick the adapter: explicit override, then TERM_PROGRAM, then whichever supported terminal is
 * running. Returns undefined when none is available; throws on an unknown override.
 */
export function detectAdapter (env: Record<string, string | undefined>, exec: Exec, override?: string): TerminalAdapter | undefined {
  if (override !== undefined) {
    if (!(override in FACTORIES)) throw new Error(`unknown terminal "${override}" (supported: ${Object.keys(FACTORIES).join(', ')})`)
    return FACTORIES[override as TerminalAdapter['name']](exec)
  }
  const fromEnv = BY_TERM_PROGRAM[env.TERM_PROGRAM ?? '']
  if (fromEnv !== undefined) return FACTORIES[fromEnv](exec)
  if (exec('pgrep', ['-x', 'iTerm2']).status === 0) return iterm2Adapter(exec)
  if (exec('wezterm', ['cli', 'list', '--format', 'json']).status === 0) return weztermAdapter(exec)
  return undefined
}
