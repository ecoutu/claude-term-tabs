import { basename } from 'node:path'
import type { Exec } from './types.ts'

const SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh'])

/** What is in front of a terminal: Claude, only a shell, or something else. */
export type Front = 'claude' | 'shell' | 'other'

/** Classify `ps -t <tty> -o pgid=,tpgid=,comm=` output by the foreground process group. */
export function foregroundKind (psOutput: string): Front {
  const front = psOutput.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    return m !== null && m[1] === m[2] ? [basename(m[3]).replace(/^-/, '')] : []
  })
  if (front.includes('claude')) return 'claude'
  if (front.length > 0 && front.every(c => SHELLS.has(c))) return 'shell'
  return 'other'
}

/** What is in front of `tty` right now; any failure reads as 'other', which blocks typing. */
export function inFrontOf (exec: Exec, tty: string): Front {
  const r = exec('ps', ['-t', tty.replace(/^\/dev\//, ''), '-o', 'pgid=,tpgid=,comm='])
  return r.status === 0 ? foregroundKind(r.stdout) : 'other'
}
