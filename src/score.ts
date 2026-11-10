import type { Candidate, Digest } from './types.ts'

/** Minimum score for a local match to switch without asking. */
export const MIN_WINNER_SCORE = 4
/** How far ahead of the runner-up a local winner must be. */
export const WINNER_RATIO = 1.5
const MAX_RECENCY_BOOST = 0.5
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MIN_PREFIX_CHARS = 3
const PREFIX_STRENGTH = 0.5

const FILLER = new Set([
  'a', 'about', 'an', 'and', 'claude', 'for', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on',
  'session', 'sessions', 'stuff', 'tab', 'that', 'the', 'thing', 'this', 'to', 'was', 'were',
  'where', 'which', 'with', 'work', 'working'
])

const TICKET = /^[a-z]+-\d+$/

type Field = 'title' | 'repo' | 'worktree' | 'branch' | 'lastPrompt' | 'firstPrompt'

const FIELD_WEIGHTS: Readonly<Record<Field, number>> = {
  title: 3,
  repo: 3,
  worktree: 2,
  branch: 2,
  lastPrompt: 2,
  firstPrompt: 1
}

/** A candidate with its local relevance score. */
export interface Ranked { cand: Candidate, score: number }

/** Lowercased query tokens with filler words removed; hyphenated words stay whole. */
export function tokenize (query: string): string[] {
  return query.toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map(t => t.replace(/^-+|-+$/g, ''))
    .filter(t => t !== '' && !FILLER.has(t))
}

/** Candidates matching the query, highest score first. Rarer tokens count for more. */
export function rankLocal (query: string, cands: Candidate[], now: number = Date.now()): Ranked[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const words = cands.map(c => fieldWords(c.digest))
  const hits = tokens.map(t => words.map(w => bestHit(t, w)))
  const idf = hits.map(perCand => {
    const df = perCand.filter(h => h > 0).length
    return df === 0 ? 0 : Math.log(1 + cands.length / df)
  })
  return cands
    .map((cand, i) => {
      const base = hits.reduce((sum, perCand, t) => sum + perCand[i] * idf[t], 0)
      return { cand, score: base > 0 ? base + recencyBoost(cand.digest.lastActive, now) : 0 }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** The top candidate when it is strong enough and well ahead of the runner-up. */
export function clearWinner (ranked: Ranked[]): Candidate | undefined {
  const [top, next] = ranked
  if (top === undefined || top.score < MIN_WINNER_SCORE) return undefined
  if (next !== undefined && top.score < next.score * WINNER_RATIO) return undefined
  return top.cand
}

function fieldWords (d: Digest): Map<Field, string[]> {
  const entries = (Object.keys(FIELD_WEIGHTS) as Field[]).map(f => [f, splitWords(d[f])] as const)
  return new Map(entries)
}

function splitWords (text: string | undefined): string[] {
  if (text === undefined) return []
  const whole = text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean)
  const parts = whole.flatMap(w => w.includes('-') ? w.split('-').filter(Boolean) : [])
  return [...whole, ...parts]
}

function bestHit (token: string, words: Map<Field, string[]>): number {
  let best = 0
  for (const [field, list] of words) {
    const strength = matchStrength(token, list)
    best = Math.max(best, strength * FIELD_WEIGHTS[field])
  }
  return best
}

function matchStrength (token: string, words: string[]): number {
  if (words.includes(token)) return 1
  if (TICKET.test(token) || token.length < MIN_PREFIX_CHARS) return 0
  return words.some(w => w.startsWith(token)) ? PREFIX_STRENGTH : 0
}

function recencyBoost (lastActive: number, now: number): number {
  const age = Math.max(0, now - lastActive)
  return MAX_RECENCY_BOOST * Math.max(0, 1 - age / RECENCY_WINDOW_MS)
}
