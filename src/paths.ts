import { homedir } from 'node:os'
import { join } from 'node:path'

const WORKTREE_MARKER = '/.claude/worktrees/'

/** Repo name for a session cwd, unwrapping `<repo>/.claude/worktrees/<slug>`. */
export function repoName (cwd: string): { repo: string, worktree?: string } {
  const clean = cwd.replace(/\/+$/, '')
  const at = clean.indexOf(WORKTREE_MARKER)
  if (at >= 0) {
    const worktree = clean.slice(at + WORKTREE_MARKER.length).split('/')[0]
    return { repo: lastSegment(clean.slice(0, at)), worktree }
  }
  return { repo: lastSegment(clean) }
}

function lastSegment (p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Path of a session transcript: projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl. */
export function transcriptPath (projectsDir: string, cwd: string, sessionId: string): string {
  return join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
}

/** Default locations, overridable for tests. */
export const defaultDirs = {
  sessions: join(homedir(), '.claude', 'sessions'),
  projects: join(homedir(), '.claude', 'projects'),
  cache: join(homedir(), '.cache', 'claude-tabs', 'digests.json'),
  config: join(homedir(), '.config', 'claude-tabs', 'config.json'),
  snapshots: join(homedir(), '.local', 'state', 'claude-tabs', 'snapshots')
}
