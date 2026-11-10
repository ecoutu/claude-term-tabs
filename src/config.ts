import { readFileSync } from 'node:fs'

/** Prompt typed into every session by `ct pause`. */
export const DEFAULT_STOP_PROMPT = "Pausing for a machine restart. Stop at the nearest safe point: start nothing new, and do not push, merge, apply, post or transition anything that was not already mid-flight. Leave no file half-edited; do not commit unless that was already the plan. Background jobs, Monitors, /loop wakeups and subagents will die with the restart.\n\nThen reply with a message headed HANDOFF (under 20 lines):\n- Goal: what this session is for (ticket/PR refs)\n- Done: what is finished, with PR numbers, commits, ticket states\n- In flight: branch, worktree path, uncommitted changes, anything half-done\n- Lost on restart: background watches/monitors/loops/agents and how to restart them\n- Next step: the exact next action\n- Open questions: anything you need from me\n\nThen stop and wait.\n"

/** Prompt passed to every session reopened by `ct resume`. */
export const DEFAULT_RESUME_PROMPT = "Resumed after a machine restart. Find your most recent HANDOFF message above and pick up from its \"Next step\". Before acting, re-check live state, since anything may have moved while we were down: git branch and status (and worktree path if any), PR and CI status, and Jira status for any ticket involved. Restart any background watches, monitors or loops the handoff lists. Then give me a 3-line status and continue. If there is no HANDOFF message, summarize where we left off and ask before doing anything.\n"

const DEFAULT_PAUSE_TIMEOUT_MINUTES = 10

/** User config from ~/.config/claude-tabs/config.json, with defaults applied. */
export interface Config {
  resumeCommand?: string
  stopPrompt: string
  resumePrompt: string
  pauseTimeoutMinutes: number
}

/** Load config; a missing file gives defaults, anything unreadable or invalid throws. */
export function loadConfig (path: string): Config {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return withDefaults({})
    throw new Error(`cannot read config ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid config ${path}: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`invalid config ${path}: not an object`)
  return withDefaults(validate(parsed as Record<string, unknown>, path))
}

function validate (o: Record<string, unknown>, path: string): Partial<Config> {
  const bad = (key: string, want: string) => new Error(`invalid config ${path}: ${key} must be ${want}`)
  if (o.resumeCommand !== undefined && typeof o.resumeCommand !== 'string') throw bad('resumeCommand', 'a string')
  for (const key of ['stopPrompt', 'resumePrompt'] as const) {
    if (o[key] !== undefined && (typeof o[key] !== 'string' || o[key] === '')) throw bad(key, 'a non-empty string')
  }
  const t = o.pauseTimeoutMinutes
  if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t <= 0)) throw bad('pauseTimeoutMinutes', 'a positive number')
  return o as Partial<Config>
}

function withDefaults (c: Partial<Config>): Config {
  return {
    resumeCommand: c.resumeCommand,
    stopPrompt: c.stopPrompt ?? DEFAULT_STOP_PROMPT,
    resumePrompt: c.resumePrompt ?? DEFAULT_RESUME_PROMPT,
    pauseTimeoutMinutes: c.pauseTimeoutMinutes ?? DEFAULT_PAUSE_TIMEOUT_MINUTES
  }
}
