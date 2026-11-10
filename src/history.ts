import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type { DigestCache } from './cache.ts'
import { extractDigest } from './transcript.ts'
import type { Candidate } from './types.ts'

const DEFAULT_RESUME = 'claude --resume {id}'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/** Closed sessions: every top-level transcript under projectsDir whose id is not live. */
export function listClosedSessions (opts: {
  projectsDir: string
  liveIds: Set<string>
  cache: DigestCache
  dirExists: (p: string) => boolean
}): Candidate[] {
  return readdirSync(opts.projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => readdirSync(join(opts.projectsDir, d.name), { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
      .map(f => ({ path: join(opts.projectsDir, d.name, f.name), sessionId: f.name.slice(0, -'.jsonl'.length) })))
    .filter(t => !opts.liveIds.has(t.sessionId))
    .map(t => {
      const digest = opts.cache.get(t.path, () => extractDigest(t.path, { sessionId: t.sessionId }))
      return { digest, live: false, status: 'unknown' as const, dirGone: !isResumableDir(digest.cwd, opts.dirExists) }
    })
}

/** Shell command that resumes a session, from config `resumeCommand` (must contain `{id}`). */
export function resumeCommand (config: { resumeCommand?: string }, sessionId: string): string {
  const template = config.resumeCommand ?? DEFAULT_RESUME
  if (!template.includes('{id}')) throw new Error('config resumeCommand must contain {id}')
  if (!SESSION_ID.test(sessionId)) throw new Error(`refusing to resume unexpected session id "${sessionId}"`)
  return template.replaceAll('{id}', sessionId)
}

/** True when `p` is an existing directory. */
export function dirExists (p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** True when cwd is an absolute, normalized path to an existing directory. */
export function isResumableDir (cwd: string, exists: (p: string) => boolean): boolean {
  return cwd !== '' && isAbsolute(cwd) && normalize(cwd) === cwd && exists(cwd)
}
