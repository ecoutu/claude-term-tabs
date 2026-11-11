import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { repoName } from './paths.ts'
import type { Digest } from './types.ts'

const HEAD_BYTES = 64 * 1024
const DEFAULT_TAIL_BYTES = 256 * 1024
const PROMPT_CHARS = 200
const WRAPPER_PREFIXES = ['<command', '<local-command', '<system', '<user-prompt-submit-hook', 'Caveat:']
/** Claude Code records pasted text between `<pasted_content id="…">` and `</pasted_content id="…">` tags. */
const PASTE_TAG = /<\/?pasted_content\b[^>]*>/g

type Entry = Record<string, unknown>

interface TailFields {
  customTitle?: string
  aiTitle?: string
  summary?: string
  lastPrompt?: string
  branch?: string
  cwd?: string
}

/**
 * Build a Digest from a transcript by reading its head (first prompt, cwd) and a tail window
 * (latest title, last prompt, branch). A missing or unreadable file yields the fallback fields
 * plus a `note`; it never throws.
 */
export function extractDigest (
  path: string,
  fallback: { sessionId: string, cwd?: string },
  opts: { tailBytes?: number } = {}
): Digest {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    return fallbackDigest(fallback, `transcript unreadable: ${(err as Error).message}`)
  }
  try {
    const { size, mtimeMs } = fstatSync(fd)
    const headEntries = parseLines(readRange(fd, 0, Math.min(size, HEAD_BYTES)), false)
    const tail = readTail(fd, size, opts.tailBytes ?? DEFAULT_TAIL_BYTES)
    const cwd = tail.cwd ?? firstString(headEntries, 'cwd') ?? fallback.cwd ?? ''
    return {
      sessionId: fallback.sessionId,
      cwd,
      ...repoName(cwd),
      title: tail.customTitle ?? tail.aiTitle ?? tail.summary,
      firstPrompt: firstRealPrompt(headEntries),
      lastPrompt: trimPrompt(tail.lastPrompt),
      branch: tail.branch ?? firstString(headEntries, 'gitBranch'),
      lastActive: Math.round(mtimeMs)
    }
  } finally {
    closeSync(fd)
  }
}

function fallbackDigest (fallback: { sessionId: string, cwd?: string }, note: string): Digest {
  const cwd = fallback.cwd ?? ''
  return { sessionId: fallback.sessionId, cwd, ...repoName(cwd), lastActive: 0, note }
}

function readRange (fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length)
  const read = readSync(fd, buf, 0, length, start)
  return buf.subarray(0, read).toString('utf8')
}

function readTail (fd: number, size: number, initial: number): TailFields {
  let window = Math.max(1, initial)
  for (;;) {
    const start = Math.max(0, size - window)
    const entries = parseLines(readRange(fd, start, size - start), start > 0)
    const fields = collectTail(entries)
    const titled = fields.customTitle ?? fields.aiTitle ?? fields.summary
    if (titled !== undefined || start === 0) return fields
    window *= 2
  }
}

function parseLines (text: string, dropFirst: boolean): Entry[] {
  const lines = text.split('\n')
  const usable = dropFirst ? lines.slice(1) : lines
  return usable.flatMap(line => {
    if (line.trim() === '') return []
    try {
      const parsed: unknown = JSON.parse(line)
      return isEntry(parsed) ? [parsed] : []
    } catch {
      return []
    }
  })
}

function isEntry (v: unknown): v is Entry {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function collectTail (entries: Entry[]): TailFields {
  return entries.reduce<TailFields>((acc, e) => ({
    customTitle: e.type === 'custom-title' ? str(e.customTitle) ?? acc.customTitle : acc.customTitle,
    aiTitle: e.type === 'ai-title' ? str(e.aiTitle) ?? acc.aiTitle : acc.aiTitle,
    summary: e.type === 'summary' ? str(e.summary) ?? acc.summary : acc.summary,
    lastPrompt: e.type === 'last-prompt' ? str(e.lastPrompt) ?? acc.lastPrompt : acc.lastPrompt,
    branch: str(e.gitBranch) ?? acc.branch,
    cwd: str(e.cwd) ?? acc.cwd
  }), {})
}

function firstString (entries: Entry[], key: string): string | undefined {
  for (const e of entries) {
    const v = str(e[key])
    if (v !== undefined) return v
  }
  return undefined
}

function firstRealPrompt (entries: Entry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== 'user' || e.isMeta === true) continue
    const text = userText(e.message)
    if (text !== undefined && !WRAPPER_PREFIXES.some(p => text.trimStart().startsWith(p))) {
      return trimPrompt(text)
    }
  }
  return undefined
}

function userText (message: unknown): string | undefined {
  if (!isEntry(message)) return undefined
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.filter(isEntry).filter(b => b.type === 'text').map(b => str(b.text) ?? '')
  const joined = texts.join(' ').trim()
  return joined === '' ? undefined : joined
}

function trimPrompt (text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS)
}

/** A prompt as it was typed, without the tags Claude Code puts around pasted text. */
export function withoutPasteTags (text: string): string {
  return text.replace(PASTE_TAG, '')
}

function str (v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}
