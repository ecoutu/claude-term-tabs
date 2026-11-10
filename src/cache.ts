import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Digest } from './types.ts'

const CACHE_VERSION = 1

interface Entry { size: number, mtimeMs: number, digest: Digest }
interface CacheFile { version: number, entries: Record<string, Entry> }

/** Digest cache keyed by transcript path, valid while the file's size and mtime are unchanged. */
export class DigestCache {
  private readonly file: string
  private entries: Map<string, Entry>
  private dirty = false

  private constructor (file: string, entries: Map<string, Entry>) {
    this.file = file
    this.entries = entries
  }

  /** Load the cache; a missing file is empty, a corrupt one is discarded with one warning. */
  static load (file: string, warn: (m: string) => void): DigestCache {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warn(`claude-tabs: cache unreadable (${(err as Error).message}), rebuilding`)
      return new DigestCache(file, new Map())
    }
    try {
      const parsed = JSON.parse(raw) as CacheFile
      if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return new DigestCache(file, new Map())
      }
      return new DigestCache(file, new Map(Object.entries(parsed.entries)))
    } catch {
      warn(`claude-tabs: cache at ${file} is corrupt, rebuilding`)
      return new DigestCache(file, new Map())
    }
  }

  /** Cached digest for `path`, or the result of `extract` when stale. Missing files are never cached. */
  get (path: string, extract: () => Digest): Digest {
    let stat
    try {
      stat = statSync(path)
    } catch {
      return extract()
    }
    const hit = this.entries.get(path)
    if (hit !== undefined && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.digest
    const digest = extract()
    this.entries = new Map(this.entries).set(path, { size: stat.size, mtimeMs: stat.mtimeMs, digest })
    this.dirty = true
    return digest
  }

  /** Write the cache atomically when anything changed. */
  save (): void {
    if (!this.dirty && existsSync(this.file)) return
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const body: CacheFile = { version: CACHE_VERSION, entries: Object.fromEntries(this.entries) }
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(body))
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
    this.dirty = false
  }
}
