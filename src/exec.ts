import { spawnSync } from 'node:child_process'
import type { Exec } from './types.ts'

const MAX_BUFFER = 64 * 1024 * 1024

/** Real Exec backed by spawnSync. A spawn failure (e.g. ENOENT) returns status 127. */
export const realExec: Exec = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: MAX_BUFFER })
  if (r.error) return { status: 127, stdout: '', stderr: `${cmd}: ${r.error.message}` }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
