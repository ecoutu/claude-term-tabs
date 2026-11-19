import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Candidate, Digest, Exec } from './types.ts'
import { shellQuote } from './shell.ts'

const SEP = ' · '
const FZF_CANCEL = new Set([1, 130])
const ACCEPT_WHEN_MARKED = '[ "${FZF_SELECT_COUNT:-0}" -gt 0 ] && echo accept'
const MULTI_HEADER = 'Tab marks a session, Enter sends to the marked ones'

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
  ].filter((f): f is string => f !== undefined && f !== '').map(cleanField)
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
  if (io.hasFzf) return byId.get(runFzf(lines, cands, exec)[0] ?? '')
  const menu = lines.map((l, i) => `${String(i + 1).padStart(2)}) ${l.split('\t')[1]}`).join('\n')
  const answer = io.prompt(`${menu}\nPick a session (number, Enter to cancel): `).trim()
  const n = Number(answer)
  return Number.isInteger(n) && n >= 1 && n <= cands.length ? cands[n - 1] : undefined
}

/** How `pickMany` shows its rows: a summary per session id, and whether fzf starts with every row marked. */
export interface PickManyOptions { summaries?: Map<string, string>, preselect?: boolean }

/** Let the user choose any number of candidates with fzf --multi, or a numbered list without it. Cancel chooses none; a mistyped list throws. */
export function pickMany (cands: Candidate[], exec: Exec, io: PickerIo, opts: PickManyOptions = {}): Candidate[] {
  const now = Date.now()
  const lines = cands.map(c => formatPickerLine(c, opts.summaries?.get(c.digest.sessionId), now))
  if (io.hasFzf) {
    const byId = new Map(cands.map(c => [c.digest.sessionId, c]))
    const marked = opts.preselect === true ? ['--bind', 'load:select-all'] : []
    const acceptOnlyMarked = ['enter', 'double-click'].flatMap(key => ['--bind', `${key}:transform:${ACCEPT_WHEN_MARKED}`])
    return runFzf(lines, cands, exec, ['--multi', '--header', MULTI_HEADER, ...acceptOnlyMarked, ...marked]).flatMap(id => byId.get(id) ?? [])
  }
  const menu = lines.map((l, i) => `${String(i + 1).padStart(2)}) ${l.split('\t')[1]}`).join('\n')
  const answer = io.prompt(`${menu}\nPick sessions (numbers like 1,3, or all; Enter to cancel): `).trim()
  return chosenByNumber(answer, cands)
}

function chosenByNumber (answer: string, cands: Candidate[]): Candidate[] {
  if (answer.toLowerCase() === 'all') return cands
  const numbers = answer.split(/[\s,]+/).filter(Boolean).map(Number)
  const valid = numbers.every(n => Number.isInteger(n) && n >= 1 && n <= cands.length)
  if (!valid) throw new Error(`invalid choice "${answer}": use numbers 1-${cands.length} separated by commas, or all`)
  return [...new Set(numbers)].map(n => cands[n - 1])
}

function runFzf (lines: string[], cands: Candidate[], exec: Exec, extraArgs: string[] = []): string[] {
  const previewDir = mkdtempSync(join(tmpdir(), 'claude-term-tabs-'))
  try {
    for (const c of cands) writeFileSync(join(previewDir, c.digest.sessionId), previewText(c.digest), { mode: 0o600 })
    const r = exec('fzf', [
      '--delimiter', '\t', '--with-nth', '2..', '--no-sort', '--height', '60%', '--reverse',
      ...extraArgs,
      '--prompt', 'session> ',
      '--preview', `cat ${shellQuote(previewDir)}/{1}`, '--preview-window', 'down,6,wrap'
    ], lines.join('\n'))
    if (FZF_CANCEL.has(r.status)) return []
    if (r.status !== 0) throw new Error(`fzf failed (${r.status}): ${r.stderr.trim()}`)
    return r.stdout.split('\n').filter(line => line.trim() !== '').map(parsePickerSelection)
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
  ].map(cleanField).join('\n')
}

function tabLabel (c: Candidate): string {
  return `tab ${c.pane?.tabIndex ?? '?'}`
}

/** Flatten control characters and escape sequences out of a display field. */
export function cleanField (s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}
