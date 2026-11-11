import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeOwnerOnly } from './fsutil.ts'
import type { TerminalAdapter } from './terminals/adapter.ts'
import type { Candidate } from './types.ts'

const SUFFIX = '.json'
const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/

/** One session recorded by `ctt pause`. */
export interface SnapshotSession {
  sessionId: string
  cwd: string
  title?: string
  repo: string
  branch?: string
  windowIndex?: number
  tabIndex?: number
  terminal?: TerminalAdapter['name']
  handoffWritten: boolean
}

/** Every session open when `ctt pause` started. */
export interface Snapshot { id: string, createdAt: string, sessions: SnapshotSession[] }

/** Build a snapshot of live candidates; its id is the creation time with ':' as '-'. */
export function snapshotFrom (cands: Candidate[], terminal: TerminalAdapter['name'] | undefined, now: number): Snapshot {
  const createdAt = new Date(now).toISOString()
  return {
    id: createdAt.replaceAll(':', '-'),
    createdAt,
    sessions: cands.map(c => ({
      sessionId: c.digest.sessionId,
      cwd: c.digest.cwd,
      title: c.digest.title,
      repo: c.digest.repo,
      branch: c.digest.branch,
      windowIndex: c.pane?.windowIndex,
      tabIndex: c.pane?.tabIndex,
      terminal: c.pane !== undefined ? terminal : undefined,
      handoffWritten: false
    }))
  }
}

/** Write (or overwrite) a snapshot owner-only; returns its path. */
export function saveSnapshot (dir: string, snap: Snapshot): string {
  const path = join(dir, `${snap.id}${SUFFIX}`)
  writeOwnerOnly(path, JSON.stringify(snap, null, 2))
  return path
}

/** Newest snapshot, or undefined when there is none. A corrupt newest file throws rather than falling back. */
export function latestSnapshot (dir: string): Snapshot | undefined {
  const newest = snapshotFiles(dir).at(-1)
  if (newest === undefined) return undefined
  const path = join(dir, newest)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Snapshot
  } catch (err) {
    throw new Error(`snapshot ${path} is unreadable: ${(err as Error).message}`)
  }
}

/** Delete snapshots created more than `maxAgeMs` before `now`; returns the deleted paths. */
export function pruneSnapshots (dir: string, now: number, maxAgeMs: number): string[] {
  const cutoff = now - maxAgeMs
  const old = snapshotFiles(dir).filter(name => Date.parse(name.slice(0, -SUFFIX.length).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')) < cutoff)
  return old.map(name => {
    const path = join(dir, name)
    rmSync(path)
    return path
  })
}

function snapshotFiles (dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => NAME.test(name)).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
