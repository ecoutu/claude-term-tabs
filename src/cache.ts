import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeOwnerOnly } from './fsutil.ts'
import type { Digest } from './types.ts'

const CACHE_VERSION = 2

interface Entry { size: number, mtimeMs: number, digest: Digest }
interface CacheFile { version: number, entries: Record<string, Entry> }

/** Digest cache keyed by transcript path, valid while the file's size and mtime are unchanged. */
export class DigestCache {
  private readonly file: string
  private readonly entries: Map<string, Entry>
  private readonly seen = new Set<string>()
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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warn(`claude-term-tabs: cache unreadable (${(err as Error).message}), rebuilding`)
      return new DigestCache(file, new Map())
    }
    try {
      const parsed = JSON.parse(raw) as CacheFile
      if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return new DigestCache(file, new Map())
      }
      return new DigestCache(file, new Map(Object.entries(parsed.entries)))
    } catch {
      warn(`claude-term-tabs: cache at ${file} is corrupt, rebuilding`)
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
    this.seen.add(path)
    const hit = this.entries.get(path)
    if (hit !== undefined && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.digest
    const digest = extract()
    this.entries.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, digest })
    this.dirty = true
    return digest
  }

  /** Paths looked up through `get` during this run. */
  touched (): Set<string> {
    return new Set(this.seen)
  }

  /** Drop every entry whose path is not in `paths` (call after a full listing). */
  retainOnly (paths: Set<string>): void {
    for (const key of [...this.entries.keys()]) {
      if (!paths.has(key)) {
        this.entries.delete(key)
        this.dirty = true
      }
    }
  }

  /** Write the cache atomically when anything changed. */
  save (): void {
    if (!this.dirty && existsSync(this.file)) return
    const body: CacheFile = { version: CACHE_VERSION, entries: Object.fromEntries(this.entries) }
    writeOwnerOnly(this.file, JSON.stringify(body))
    this.dirty = false
  }
}
