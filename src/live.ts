import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DigestCache } from './cache.ts'
import { transcriptPath } from './paths.ts'
import { extractDigest } from './transcript.ts'
import type { Candidate, Exec, Status } from './types.ts'

const STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'shell'])

interface PidFile { pid: number, sessionId: string, cwd: string, status?: string, entrypoint?: string }
interface Proc { tty?: string, comm: string }

/** Live interactive Claude Code sessions, joined with their tty and digest. Throws when `ps` fails. */
export function collectLiveSessions (opts: {
  sessionsDir: string
  projectsDir: string
  exec: Exec
  cache: DigestCache
}): Candidate[] {
  const procs = listProcs(opts.exec)
  return readPidFiles(opts.sessionsDir)
    .filter(f => f.entrypoint === 'cli' && basename(procs.get(f.pid)?.comm ?? '') === 'claude')
    .map(f => {
      const path = findTranscript(opts.projectsDir, f.cwd, f.sessionId)
      const digest = opts.cache.get(path, () => extractDigest(path, { sessionId: f.sessionId, cwd: f.cwd }))
      return {
        digest,
        live: true,
        status: toStatus(f.status),
        tty: procs.get(f.pid)?.tty
      }
    })
}

function listProcs (exec: Exec): Map<number, Proc> {
  const r = exec('ps', ['-axo', 'pid=,tty=,comm='])
  if (r.status !== 0) throw new Error(`ps failed (${r.status}): ${r.stderr.trim()}`)
  const rows = r.stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (m === null) return []
    const tty = m[2] === '??' || m[2] === '-' ? undefined : `/dev/${m[2]}`
    return [[Number(m[1]), { tty, comm: m[3] }] as const]
  })
  return new Map(rows)
}

function readPidFiles (dir: string): PidFile[] {
  return readdirSync(dir)
    .filter(name => /^\d+\.json$/.test(name))
    .flatMap(name => {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<PidFile>
        if (typeof parsed.pid !== 'number' || typeof parsed.sessionId !== 'string' || typeof parsed.cwd !== 'string') return []
        return [parsed as PidFile]
      } catch {
        return []
      }
    })
}

function findTranscript (projectsDir: string, cwd: string, sessionId: string): string {
  const direct = transcriptPath(projectsDir, cwd, sessionId)
  if (existsSync(direct)) return direct
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return direct
}

function toStatus (s: string | undefined): Status {
  return s !== undefined && STATUSES.has(s) ? s as Status : 'unknown'
}
