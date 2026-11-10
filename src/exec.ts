import { spawnSync } from 'node:child_process'
import type { Exec } from './types.ts'

const MAX_BUFFER = 64 * 1024 * 1024

/** Real Exec backed by spawnSync. Spawn failure returns status 127, a timeout 124. */
export const realExec: Exec = (cmd, args, input, opts) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: MAX_BUFFER, timeout: opts?.timeoutMs })
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return { status: 124, stdout: '', stderr: `${cmd}: timed out` }
  if (r.error) return { status: 127, stdout: '', stderr: `${cmd}: ${r.error.message}` }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
