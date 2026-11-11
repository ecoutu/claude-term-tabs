import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, writeSync } from 'node:fs'
import { parseArgs as parseNodeArgs } from 'node:util'
import { DigestCache } from './cache.ts'
import { loadConfig, type Config } from './config.ts'
import { realExec } from './exec.ts'
import { dirExists as realDirExists, listClosedSessions, resumeCommand } from './history.ts'
import { collectLiveSessions } from './live.ts'
import { askHaiku, MAX_LLM_CANDIDATES } from './llm.ts'
import { defaultDirs } from './paths.ts'
import { formatPickerLine, pick as realPick } from './picker.ts'
import { clearWinner, rankLocal, tokenize } from './score.ts'
import { detectAdapter, type TerminalAdapter } from './terminals/adapter.ts'
import { runCommand } from './commands.ts'
import { listPanesOrWarn } from './discover.ts'
import { HELP } from './help.ts'

export { runCommand }
import type { Candidate, Exec, Pane } from './types.ts'

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
  const { values, positionals } = parseNodeArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      list: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'no-llm': { type: 'boolean', default: false },
      terminal: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
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
    deps.stderr(`claude-tabs: ${(err as Error).message}`)
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
    deps.stderr('claude-tabs: no supported terminal pane for this session, so not switching')
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
    deps.stderr(`claude-tabs: could not save cache: ${(err as Error).message}`)
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

function shellQuote (s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}

const realExecTty: Exec = (cmd, args, input) => {
  if (process.env.CT_NO_REAL_EXEC === '1') return { status: 126, stdout: '', stderr: `${cmd}: blocked by CT_NO_REAL_EXEC` }
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

/** Entry point used by bin/claude-tabs. */
export async function main (argv: string[]): Promise<number> {
  const hasFzf = realExec('sh', ['-c', 'command -v fzf']).status === 0
  const write = (fd: number) => (s: string) => { writeSync(fd, `${s}\n`) }
  const deps: Deps = {
    exec: realExec,
    execTty: realExecTty,
    dirs: defaultDirs,
    stdout: write(1),
    stderr: write(2),
    prompt: promptTty,
    now: Date.now,
    isTty: process.stdout.isTTY === true,
    hasFzf,
    dirExists: realDirExists,
    resolveAdapter: override => detectAdapter(process.env, realExec, override),
    pick: (cands, summaries) => realPick(cands, summaries, realExecTty, { hasFzf, prompt: promptTty }),
    isAlive: pid => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    self: [process.execPath, process.argv[1]]
  }
  const sub = await runCommand(argv, deps)
  if (sub !== undefined) return sub
  let opts: Options
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`claude-tabs: ${(err as Error).message}\n${HELP}\n`)
    return EXIT_ERROR
  }
  return run(opts, deps)
}
