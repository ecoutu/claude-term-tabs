import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DigestCache } from './cache.ts'
import { transcriptPath } from './paths.ts'
import { extractDigest } from './transcript.ts'
import type { Candidate, Exec, Status } from './types.ts'

const STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'shell'])
const PID_REUSE_SLACK_MS = 120_000

interface PidFile { pid: number, sessionId: string, cwd: string, status?: string, entrypoint?: string, startedAt?: number }
interface Proc { tty?: string, comm: string, startedMs: number }

/** Live interactive Claude Code sessions, joined with their tty and digest. Throws when `ps` fails. */
export function collectLiveSessions (opts: {
  sessionsDir: string
  projectsDir: string
  exec: Exec
  cache: DigestCache
  now?: () => number
}): Candidate[] {
  const procs = listProcs(opts.exec, (opts.now ?? Date.now)())
  return readPidFiles(opts.sessionsDir)
    .filter(f => f.entrypoint === 'cli' && isSameProcess(f, procs.get(f.pid)))
    .map(f => {
      const path = transcriptFor(opts.projectsDir, f.cwd, f.sessionId)
      const digest = opts.cache.get(path, () => extractDigest(path, { sessionId: f.sessionId, cwd: f.cwd }))
      return {
        digest,
        live: true,
        pid: f.pid,
        status: toStatus(f.status),
        tty: procs.get(f.pid)?.tty
      }
    })
}

function isSameProcess (f: PidFile, p: Proc | undefined): boolean {
  if (p === undefined || basename(p.comm) !== 'claude') return false
  return f.startedAt === undefined || p.startedMs <= f.startedAt + PID_REUSE_SLACK_MS
}

function listProcs (exec: Exec, now: number): Map<number, Proc> {
  const r = exec('ps', ['-axo', 'pid=,tty=,etime=,comm='])
  if (r.status !== 0) throw new Error(`ps failed (${r.status}): ${r.stderr.trim()}`)
  const rows = r.stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\S+)\s+([\d:-]+)\s+(.+?)\s*$/.exec(line)
    if (m === null) return []
    const tty = m[2] === '??' || m[2] === '-' ? undefined : `/dev/${m[2]}`
    return [[Number(m[1]), { tty, comm: m[4], startedMs: now - etimeMs(m[3]) }] as const]
  })
  return new Map(rows)
}

function etimeMs (etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = clock.split(':').map(Number).reverse()
  const [s = 0, m = 0, h = 0] = parts
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000
}

function readPidFiles (dir: string): PidFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return names
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

/** Transcript path for a session, falling back to a search by id across project directories. */
export function transcriptFor (projectsDir: string, cwd: string, sessionId: string): string {
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
