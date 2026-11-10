import type { Candidate, Exec } from './types.ts'

/** Most candidates sent to Haiku in one call. */
export const MAX_LLM_CANDIDATES = 15
const FIELD_CHARS = 120

const SYSTEM_PROMPT = [
  'You match a user\'s loose description to coding sessions.',
  'Each session line is: id | repo | branch | title | last prompt.',
  'Return only sessions that plausibly match, best first, each with a summary of at most 12 words.',
  'Return an empty list when none match.'
].join(' ')

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, summary: { type: 'string' } },
        required: ['sessionId', 'summary']
      }
    }
  },
  required: ['matches']
})

/** One ranked match returned by Haiku. */
export interface LlmMatch { sessionId: string, summary: string }

/** CLI args and stdin for a minimal, unsaved `claude -p` Haiku call. */
export function buildHaikuArgs (query: string, cands: Candidate[]): { args: string[], input: string } {
  const args = [
    '-p',
    '--model', 'haiku',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--output-format', 'json',
    '--json-schema', SCHEMA,
    '--system-prompt', SYSTEM_PROMPT
  ]
  const lines = cands.slice(0, MAX_LLM_CANDIDATES).map(c => {
    const d = c.digest
    return [d.sessionId, d.worktree !== undefined ? `${d.repo}/${d.worktree}` : d.repo, d.branch, d.title, d.lastPrompt]
      .map(v => clean(v)).join(' | ')
  })
  return { args, input: `Description: ${clean(query)}\n\nSessions:\n${lines.join('\n')}\n` }
}

/** Parse `claude -p --output-format json` output into matches with known ids. Throws on malformed output. */
export function parseHaikuRanking (stdout: string, knownIds: Set<string>): LlmMatch[] {
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('Haiku output was not JSON')
  }
  const payload = envelope.structured_output ?? parseResultText(envelope.result)
  const matches = (payload as { matches?: unknown } | undefined)?.matches
  if (!Array.isArray(matches)) throw new Error('Haiku output had no matches array')
  return matches.flatMap(m => {
    const id = (m as LlmMatch)?.sessionId
    const summary = (m as LlmMatch)?.summary
    return typeof id === 'string' && knownIds.has(id) ? [{ sessionId: id, summary: typeof summary === 'string' ? summary : '' }] : []
  })
}

/** Ask Haiku to rank candidates. Returns undefined (after warning) when the call fails in any way. */
export function askHaiku (query: string, cands: Candidate[], exec: Exec, warn: (m: string) => void): LlmMatch[] | undefined {
  const sent = cands.slice(0, MAX_LLM_CANDIDATES)
  const { args, input } = buildHaikuArgs(query, sent)
  const r = exec('claude', args, input)
  if (r.status === 127) {
    warn('claude-tabs: claude not found, using local ranking')
    return undefined
  }
  if (r.status !== 0) {
    warn(`claude-tabs: Haiku call failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 200)}; using local ranking`)
    return undefined
  }
  try {
    return parseHaikuRanking(r.stdout, new Set(sent.map(c => c.digest.sessionId)))
  } catch (err) {
    warn(`claude-tabs: ${(err as Error).message}; using local ranking`)
    return undefined
  }
}

function parseResultText (result: unknown): unknown {
  if (typeof result !== 'string') return undefined
  const body = result.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '')
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function clean (v: string | undefined): string {
  return (v ?? '').replace(/[\s|]+/g, ' ').trim().slice(0, FIELD_CHARS)
}
