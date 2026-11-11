import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { isatty } from 'node:tty'
import { parseFlags, SEARCH_FLAGS } from './args.ts'
import { DigestCache } from './cache.ts'
import { loadConfig, type Config } from './config.ts'
import { realExec } from './exec.ts'
import { dirExists as realDirExists, listClosedSessions, resumeCommand } from './history.ts'
import { collectLiveSessions } from './live.ts'
import { askHaiku, MAX_LLM_CANDIDATES } from './llm.ts'
import { lineWriter } from './output.ts'
import { defaultDirs } from './paths.ts'
import { formatPickerLine, pick as realPick } from './picker.ts'
import { clearWinner, rankLocal, tokenize } from './score.ts'
import { detectAdapter, type TerminalAdapter } from './terminals/adapter.ts'
import { runCommand } from './commands.ts'
import { listPanesOrWarn } from './discover.ts'
import { HELP } from './help.ts'

export { runCommand }
import type { Candidate, Exec, Pane } from './types.ts'
import { shellQuote } from './shell.ts'

const EXIT_OK = 0
const EXIT_NONE = 1
const EXIT_ERROR = 2

/** Parsed command-line options. */
export interface Options {
  query: string
  list: boolean
  all: boolean
  json: boolean
  noLlm: boolean
  terminal?: string
  help: boolean
}

/** Everything `run` touches outside its own logic; injected so tests can fake it. */
export interface Deps {
  exec: Exec
  execTty: Exec
  dirs: { sessions: string, projects: string, cache: string, config: string, snapshots: string }
  stdout: (s: string) => void
  stderr: (s: string) => void
  prompt: (q: string) => string
  now: () => number
  isTty: boolean
  hasFzf: boolean
  dirExists: (p: string) => boolean
  resolveAdapter: (override?: string) => TerminalAdapter | undefined
  pick: (cands: Candidate[], summaries: Map<string, string>) => Candidate | undefined
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  self: string[]
  /** What the completion script runs to answer a Tab press. */
  completionProgram: string
  /** The user's login shell ($SHELL), which `ctt completion` writes a script for by default. */
  shell: string | undefined
}

interface Context {
  opts: Options
  deps: Deps
  adapter?: TerminalAdapter
  config: Config
  multiWindow: boolean
}

/** Parse argv; throws on unknown flags. */
export function parseArgs (argv: string[]): Options {
  const { values, positionals } = parseFlags(argv, SEARCH_FLAGS, { positionals: true })
  return {
    query: positionals.join(' '),
    list: values.list || values.json,
    all: values.all,
    json: values.json,
    noLlm: values['no-llm'],
    terminal: values.terminal,
    help: values.help
  }
}

/** Run the search and act on the result. Returns the process exit code. */
export function run (opts: Options, deps: Deps): number {
  if (opts.help) {
    deps.stdout(HELP)
    return EXIT_OK
  }
  try {
    const config = loadConfig(deps.dirs.config)
    const adapter = deps.resolveAdapter(opts.terminal)
    const panes = listPanesOrWarn(adapter, deps)
    const pool = gatherCandidates(opts, deps, panes, config)
    const ctx: Context = { opts, deps, adapter, config, multiWindow: new Set(panes.map(p => p.windowIndex)).size > 1 }
    return search(ctx, pool)
  } catch (err) {
    deps.stderr(`claude-term-tabs: ${(err as Error).message}`)
    return EXIT_ERROR
  }
}

function search (ctx: Context, pool: Candidate[]): number {
  const { opts, deps } = ctx
  if (tokenize(opts.query).length === 0) return choose(ctx, byRecency(opts.all ? pool : pool.filter(c => c.live)), new Map())
  const ranked = rankLocal(opts.query, pool, deps.now())
  const winner = clearWinner(ranked)
  if (winner !== undefined) return confident(ctx, winner)
  const local = ranked.map(r => r.cand)
  if (opts.noLlm) return choose(ctx, local, new Map())
  const sent = dedupe([...local, ...byRecency(pool)]).slice(0, MAX_LLM_CANDIDATES)
  const matches = askHaiku(opts.query, sent, deps.exec, deps.stderr)
  if (matches === undefined) {
    if (local.length > 0) return choose(ctx, local, new Map())
    deps.stdout('No local match, and Haiku was unavailable (see the warning above). Try different words or --all.')
    return EXIT_NONE
  }
  const byId = new Map(sent.map(c => [c.digest.sessionId, c]))
  const found = matches.flatMap(m => byId.get(m.sessionId) ?? [])
  const summaries = new Map(matches.map(m => [m.sessionId, m.summary]))
  if (found.length === 1) return confident(ctx, found[0], summaries.get(found[0].digest.sessionId))
  return choose(ctx, found, summaries)
}

function choose (ctx: Context, cands: Candidate[], summaries: Map<string, string>): number {
  const { opts, deps } = ctx
  if (cands.length === 0) {
    deps.stdout(opts.all ? 'No matching sessions.' : 'No matching sessions. Try --all.')
    return EXIT_NONE
  }
  if (opts.list || !deps.isTty) return printList(ctx, cands, summaries)
  const chosen = deps.pick(cands, summaries)
  return chosen === undefined ? EXIT_NONE : act(ctx, chosen, summaries.get(chosen.digest.sessionId))
}

function confident (ctx: Context, c: Candidate, summary?: string): number {
  if (c.live) return act(ctx, c, summary)
  return choose(ctx, [c], new Map(summary !== undefined ? [[c.digest.sessionId, summary]] : []))
}

function act (ctx: Context, c: Candidate, summary?: string): number {
  const { opts, deps, adapter } = ctx
  if (opts.list) return printList(ctx, [c], new Map(summary !== undefined ? [[c.digest.sessionId, summary]] : []))
  if (!c.live) return resume(ctx, c)
  if (adapter === undefined || c.pane === undefined) {
    deps.stdout(`${describe(c, summary, deps.now())}`)
    deps.stderr('claude-term-tabs: no supported terminal pane for this session, so not switching')
    return EXIT_OK
  }
  adapter.focus(c.pane)
  deps.stdout(confirmation(c, ctx.multiWindow))
  return EXIT_OK
}

function resume (ctx: Context, c: Candidate): number {
  const { deps, adapter, config } = ctx
  const command = resumeCommand(config, c.digest.sessionId)
  if (c.dirGone === true) {
    deps.stdout(`${c.digest.cwd || '(unknown directory)'} no longer exists, and claude --resume only finds a session from the directory it ran in.\n  cd ${shellQuote(c.digest.cwd)} && ${command}`)
    return EXIT_NONE
  }
  if (adapter === undefined) {
    deps.stdout(`cd ${shellQuote(c.digest.cwd)} && ${command}`)
    return EXIT_OK
  }
  adapter.openPane(c.digest.cwd, command)
  deps.stdout(`→ resuming ${c.digest.title ?? c.digest.sessionId} · ${c.digest.repo} in a new tab`)
  return EXIT_OK
}

function printList (ctx: Context, cands: Candidate[], summaries: Map<string, string>): number {
  const { opts, deps } = ctx
  const now = deps.now()
  if (opts.json) {
    deps.stdout(JSON.stringify(cands.map(c => toJson(c, summaries.get(c.digest.sessionId))), null, 2))
  } else {
    deps.stdout(cands.map(c => describe(c, summaries.get(c.digest.sessionId), now)).join('\n'))
  }
  return EXIT_OK
}

function describe (c: Candidate, summary: string | undefined, now: number): string {
  const line = formatPickerLine(c, summary, now).split('\t')[1]
  return c.pane === undefined && c.tty !== undefined ? `${line} · ${c.tty}` : line
}

function confirmation (c: Candidate, multiWindow: boolean): string {
  const where = [multiWindow ? `window ${c.pane?.windowIndex}` : undefined, `tab ${c.pane?.tabIndex}`].filter(Boolean).join(' · ')
  return `→ ${c.digest.title ?? c.digest.sessionId} · ${c.digest.repo} · ${where}`
}

function toJson (c: Candidate, summary?: string): Record<string, unknown> {
  const d = c.digest
  return {
    sessionId: d.sessionId,
    title: d.title,
    repo: d.repo,
    worktree: d.worktree,
    branch: d.branch,
    cwd: d.cwd,
    live: c.live,
    status: c.status,
    lastActive: d.lastActive,
    tty: c.tty,
    window: c.pane?.windowIndex,
    tab: c.pane?.tabIndex,
    dirGone: c.dirGone,
    summary
  }
}

function gatherCandidates (opts: Options, deps: Deps, panes: Pane[], config: Config): Candidate[] {
  const cache = DigestCache.load(deps.dirs.cache, deps.stderr)
  const paneByTty = new Map(panes.map(p => [p.tty, p]))
  const live = collectLiveSessions({ sessionsDir: deps.dirs.sessions, projectsDir: deps.dirs.projects, exec: deps.exec, cache })
    .map(c => ({ ...c, pane: c.tty !== undefined ? paneByTty.get(c.tty) : undefined }))
  const closed = opts.all
    ? listClosedSessions({ projectsDir: deps.dirs.projects, liveIds: new Set(live.map(c => c.digest.sessionId)), excludeDirs: config.excludeDirs, cache, dirExists: deps.dirExists })
    : []
  if (opts.all) cache.retainOnly(cache.touched())
  try {
    cache.save()
  } catch (err) {
    deps.stderr(`claude-term-tabs: could not save cache: ${(err as Error).message}`)
  }
  return [...live, ...closed]
}


function byRecency (cands: Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => b.digest.lastActive - a.digest.lastActive)
}

function dedupe (cands: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return cands.filter(c => !seen.has(c.digest.sessionId) && seen.add(c.digest.sessionId) !== undefined)
}

const realExecTty: Exec = (cmd, args, input) => {
  if (process.env.CTT_NO_REAL_EXEC === '1') return { status: 126, stdout: '', stderr: `${cmd}: blocked by CTT_NO_REAL_EXEC` }
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] })
  if (r.error) return { status: 127, stdout: '', stderr: `${cmd}: ${r.error.message}` }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: '' }
}

function promptTty (question: string): string {
  process.stderr.write(question)
  const fd = openSync('/dev/tty', 'r')
  try {
    const buf = Buffer.alloc(256)
    const n = readSync(fd, buf, 0, buf.length, null)
    return buf.subarray(0, n).toString('utf8').split('\n')[0]
  } finally {
    closeSync(fd)
  }
}

/**
 * The real outside world. Building it runs nothing: whether fzf is installed is checked the first
 * time something asks, so completion requests, which never need it, start no process.
 */
/** `installed`: the launcher runs the built package (dist/), not a clone's src/. */
export function realDeps (exec: Exec = realExec, installed = false): Deps {
  let fzf: boolean | undefined
  const deps: Deps = {
    exec,
    execTty: realExecTty,
    dirs: defaultDirs,
    stdout: lineWriter(1),
    stderr: lineWriter(2),
    prompt: promptTty,
    now: Date.now,
    // isatty, not process.stdout.isTTY: touching process.stdout makes a piped fd 1 non-blocking.
    isTty: isatty(1),
    get hasFzf () {
      fzf ??= exec('sh', ['-c', 'command -v fzf']).status === 0
      return fzf
    },
    dirExists: realDirExists,
    resolveAdapter: override => detectAdapter(process.env, exec, override),
    pick: (cands, summaries) => realPick(cands, summaries, realExecTty, { hasFzf: deps.hasFzf, prompt: promptTty }),
    isAlive: pid => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    self: [process.execPath, process.argv[1]],
    completionProgram: completionProgram(process.argv[1], installed),
    shell: process.env.SHELL
  }
  return deps
}

/**
 * What a completion script should run. An installed package is called by name from PATH, because the path it ran
 * from may not last (npx cleans its cache; a version manager keeps one prefix per Node). A clone keeps its own path,
 * so it works without being on PATH.
 */
export function completionProgram (argv1: string, installed: boolean): string {
  return installed ? 'claude-term-tabs' : argv1
}

/** Entry point used by bin/claude-term-tabs, which says whether it runs the installed package. */
export async function main (argv: string[], { installed = false }: { installed?: boolean } = {}): Promise<number> {
  const deps = realDeps(realExec, installed)
  const sub = await runCommand(argv, deps)
  if (sub !== undefined) return sub
  let opts: Options
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`claude-term-tabs: ${(err as Error).message}\n${HELP}\n`)
    return EXIT_ERROR
  }
  return run(opts, deps)
}
