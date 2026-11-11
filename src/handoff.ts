import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const DEFAULT_TAIL_BYTES = 128 * 1024
const HANDOFF_LINE = /^\s*(?:#+\s*|\*\*)?HANDOFF\b(?!S)/m

/**
 * Text of the newest assistant transcript entry that has a text block, when it was written at or
 * after `sinceMs`. Undefined when the newest such entry is older, none exists, or the file is missing.
 */
export function latestAssistantText (path: string, sinceMs: number, opts: { tailBytes?: number } = {}): string | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = fstatSync(fd)
    let window = Math.max(1, opts.tailBytes ?? DEFAULT_TAIL_BYTES)
    for (;;) {
      const start = Math.max(0, size - window)
      const found = newestAssistantText(readRange(fd, start, size - start), start > 0)
      if (found !== undefined) return found.at >= sinceMs ? found.text : undefined
      if (start === 0) return undefined
      window *= 2
    }
  } finally {
    closeSync(fd)
  }
}

/** True when some line of `text` starts with a HANDOFF heading. */
export function hasHandoff (text: string | undefined): boolean {
  return text !== undefined && HANDOFF_LINE.test(text)
}

function newestAssistantText (chunk: string, dropFirst: boolean): { text: string, at: number } | undefined {
  const lines = chunk.split('\n')
  const usable = dropFirst ? lines.slice(1) : lines
  for (let i = usable.length - 1; i >= 0; i--) {
    const entry = parse(usable[i])
    if (entry?.type !== 'assistant') continue
    const text = textOf(entry.message)
    const at = Date.parse(String(entry.timestamp))
    if (text !== undefined && Number.isFinite(at)) return { text, at }
  }
  return undefined
}

function parse (line: string): Record<string, unknown> | undefined {
  if (line.trim() === '') return undefined
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function textOf (message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((b): b is { type: string, text: string } => typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
  return texts.length === 0 ? undefined : texts.join('\n')
}

function readRange (fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length)
  const read = readSync(fd, buf, 0, length, start)
  return buf.subarray(0, read).toString('utf8')
}

/**
 * Newest assistant text written after the newest user message that starts with `promptStart` and is
 * timestamped at or after `sinceMs`. Undefined when that prompt message, or any reply to it, is missing.
 */
export function latestAssistantAfterPrompt (path: string, promptStart: string, sinceMs: number, opts: { tailBytes?: number } = {}): string | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = fstatSync(fd)
    let window = Math.max(1, opts.tailBytes ?? DEFAULT_TAIL_BYTES)
    for (;;) {
      const start = Math.max(0, size - window)
      const lines = readRange(fd, start, size - start).split('\n')
      const entries = (start > 0 ? lines.slice(1) : lines).flatMap<Record<string, unknown>>(l => parse(l) ?? [])
      const promptAt = findLastIndex(entries, e => e.type === 'user' && Date.parse(String(e.timestamp)) >= sinceMs && (textOf(e.message) ?? '').trimStart().startsWith(promptStart))
      if (promptAt >= 0) {
        const replies = entries.slice(promptAt + 1).filter(e => e.type === 'assistant').map(e => textOf(e.message)).filter((t): t is string => t !== undefined)
        return replies.at(-1)
      }
      if (start === 0) return undefined
      window *= 2
    }
  } finally {
    closeSync(fd)
  }
}

function findLastIndex<T> (items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return i
  return -1
}
