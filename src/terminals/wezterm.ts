import type { Exec } from '../types.ts'
import type { TerminalAdapter } from './adapter.ts'

/** WezTerm adapter (implemented in Task 8). */
export function weztermAdapter (_exec: Exec): TerminalAdapter {
  throw new Error('wezterm adapter not implemented')
}
