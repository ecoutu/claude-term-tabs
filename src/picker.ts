import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Candidate, Digest, Exec } from './types.ts'

const SEP = ' · '
const FZF_CANCEL = new Set([1, 130])

/** Interactive inputs for the picker. */
export interface PickerIo { hasFzf: boolean, prompt: (question: string) => string }

/** Compact age: 5m, 3h, 2d. */
export function formatAge (lastActive: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - lastActive) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

/** One picker line: `<sessionId>\t<fields joined by ' · '>`, with control characters flattened. */
export function formatPickerLine (c: Candidate, summary?: string, now: number = Date.now()): string {
  const d = c.digest
  const fields = [
    d.title ?? '(untitled)',
    d.worktree !== undefined ? `${d.repo}/${d.worktree}` : d.repo,
    d.branch,
    formatAge(d.lastActive, now),
    c.live ? c.status : 'closed',
    c.pane !== undefined ? tabLabel(c) : undefined,
    c.dirGone === true ? 'dir gone' : undefined,
    summary
  ].filter((f): f is string => f !== undefined && f !== '').map(flatten)
  return `${d.sessionId}\t${fields.join(SEP)}`
}

/** Session id from a selected picker line. */
export function parsePickerSelection (line: string): string {
  return line.split('\t')[0].trim()
}

/** Let the user choose one candidate with fzf, or a numbered prompt without it. */
export function pick (cands: Candidate[], summaries: Map<string, string>, exec: Exec, io: PickerIo): Candidate | undefined {
  const now = Date.now()
  const lines = cands.map(c => formatPickerLine(c, summaries.get(c.digest.sessionId), now))
  const byId = new Map(cands.map(c => [c.digest.sessionId, c]))
  if (io.hasFzf) return byId.get(runFzf(lines, cands, exec) ?? '')
  const menu = lines.map((l, i) => `${String(i + 1).padStart(2)}) ${l.split('\t')[1]}`).join('\n')
  const answer = io.prompt(`${menu}\nPick a session (number, Enter to cancel): `).trim()
  const n = Number(answer)
  return Number.isInteger(n) && n >= 1 && n <= cands.length ? cands[n - 1] : undefined
}

function runFzf (lines: string[], cands: Candidate[], exec: Exec): string | undefined {
  const previewDir = mkdtempSync(join(tmpdir(), 'claude-tabs-'))
  try {
    for (const c of cands) writeFileSync(join(previewDir, c.digest.sessionId), previewText(c.digest), { mode: 0o600 })
    const r = exec('fzf', [
      '--delimiter', '\t', '--with-nth', '2..', '--no-sort', '--height', '60%', '--reverse',
      '--prompt', 'session> ',
      '--preview', `cat ${shellQuote(previewDir)}/{1}`, '--preview-window', 'down,6,wrap'
    ], lines.join('\n'))
    if (FZF_CANCEL.has(r.status)) return undefined
    if (r.status !== 0) throw new Error(`fzf failed (${r.status}): ${r.stderr.trim()}`)
    return parsePickerSelection(r.stdout)
  } finally {
    rmSync(previewDir, { recursive: true, force: true })
  }
}

function previewText (d: Digest): string {
  return [
    `repo:   ${d.repo}${d.worktree !== undefined ? ` (worktree ${d.worktree})` : ''}`,
    `branch: ${d.branch ?? ''}`,
    `cwd:    ${d.cwd}`,
    `first:  ${d.firstPrompt ?? ''}`,
    `last:   ${d.lastPrompt ?? ''}`,
    d.note !== undefined ? `note:   ${d.note}` : ''
  ].map(flatten).join('\n')
}

function shellQuote (s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}

function tabLabel (c: Candidate): string {
  return `tab ${c.pane?.tabIndex ?? '?'}`
}

function flatten (s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}
