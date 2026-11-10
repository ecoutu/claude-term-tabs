/** Session status as reported in ~/.claude/sessions/<pid>.json. */
export type Status = 'idle' | 'busy' | 'shell' | 'unknown'

/** Searchable summary of one Claude Code session transcript. */
export interface Digest {
  sessionId: string
  cwd: string
  repo: string
  worktree?: string
  title?: string
  firstPrompt?: string
  lastPrompt?: string
  branch?: string
  lastActive: number
  note?: string
}

/** One terminal pane as reported by a terminal adapter. Indexes count from 1. */
export interface Pane {
  id: string
  tty: string
  title: string
  windowId: string
  windowIndex: number
  tabIndex: number
}

/** A session that may be returned to the user, live or closed. */
export interface Candidate {
  digest: Digest
  live: boolean
  status: Status
  tty?: string
  pane?: Pane
  dirGone?: boolean
}

/** Result of running an external command. */
export interface ExecResult {
  status: number
  stdout: string
  stderr: string
}

/** Runs an external command synchronously; injected so tests can fake it. */
export type Exec = (cmd: string, args: string[], input?: string) => ExecResult
