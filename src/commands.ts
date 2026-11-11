import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { COMMANDS, completionScript, isCommand, isShell, PAUSE_FLAGS, parseFlags, RESUME_FLAGS, SHELLS } from './args.ts'
import { answerCompletion, COMPLETE_FLAG } from './complete.ts'
import type { Deps } from './cli.ts'
import { loadConfig } from './config.ts'
import { HELP } from './help.ts'
import { liveWithPanes } from './discover.ts'
import { inFrontOf, type Front } from './foreground.ts'
import type { Candidate } from './types.ts'
import { transcriptFor } from './live.ts'
import { pauseSummary, sendStop, startPause, type PauseDeps } from './pause/run.ts'
import { runStragglerUi } from './pause/ui.ts'
import { planResume, runResume } from './resume.ts'
import { latestSnapshot, type Snapshot } from './snapshot.ts'

const EXIT_OK = 0
const EXIT_NONE = 1
const EXIT_USAGE = 2

/** Run a subcommand when argv[0] names one; undefined means "not a subcommand, search instead". */
export async function runCommand (argv: string[], deps: Deps): Promise<number | undefined> {
  const [name, ...rest] = argv
  if (isCommand(name) && asksHelp(rest)) return showHelp(deps)
  try {
    switch (name) {
      case 'pause': return await pause(rest, deps)
      case 'resume': return resume(rest, deps)
      case 'completion': return completion(rest, deps)
      case COMPLETE_FLAG: return answerCompletion(rest, deps)
      case '_focus': return focus(rest, deps)
      case '_send-stop': return sendStopCommand(rest, deps)
      default: return undefined
    }
  } catch (err) {
    deps.stderr(`claude-term-tabs: ${(err as Error).message}`)
    return EXIT_USAGE
  }
}

async function pause (argv: string[], deps: Deps): Promise<number> {
  const { values } = parseFlags(argv, PAUSE_FLAGS)
  const config = loadConfig(deps.dirs.config)
  const timeoutMinutes = values.timeout !== undefined ? positive(values.timeout, '--timeout') : config.pauseTimeoutMinutes
  const adapter = deps.resolveAdapter()
  const pdeps: PauseDeps = {
    now: deps.now,
    adapter,
    collect: () => liveWithPanes(deps, adapter),
    isAlive: deps.isAlive,
    transcriptOf: c => transcriptFor(deps.dirs.projects, c.digest.cwd, c.digest.sessionId),
    sizeOf: p => statSync(p).size,
    snapshotDir: deps.dirs.snapshots,
    config,
    warn: deps.stderr,
    onSnapshot: path => { snapshotPath = path },
    inFront: c => frontOf(deps, c)
  }
  let snapshotPath = ''
  const run = startPause(pdeps, { autoClose: values['auto-close'] })
  deps.stdout(`Recorded ${run.tracked.length} sessions in ${snapshotPath}; sent the stop prompt. Waiting up to ${timeoutMinutes} min.`)
  const end = await runStragglerUi(run, pdeps, {
    hasFzf: deps.hasFzf,
    isTty: deps.isTty,
    timeoutMs: timeoutMinutes * 60_000,
    self: deps.self,
    write: deps.stdout,
    sleep: deps.sleep,
    onPick: id => { focus([id], deps) }
  })
  const summary = pauseSummary(end)
  deps.stdout(summary.text)
  return summary.exitCode
}

function resume (argv: string[], deps: Deps): number {
  const { values } = parseFlags(argv, RESUME_FLAGS)
  const config = loadConfig(deps.dirs.config)
  const snap = values.snapshot !== undefined ? readSnapshot(values.snapshot) : latestSnapshot(deps.dirs.snapshots)
  if (snap === undefined) {
    deps.stdout('No snapshot found. Run ctt pause first.')
    return EXIT_NONE
  }
  const adapter = deps.resolveAdapter()
  const liveIds = new Set(liveWithPanes(deps, adapter).map(c => c.digest.sessionId))
  const steps = planResume(snap, liveIds, deps.dirExists, config, { noPrompt: values['no-prompt'] })
  deps.stdout(`Snapshot ${snap.createdAt}: ${steps.length} sessions`)
  return runResume(steps, adapter, { dryRun: values['dry-run'] }, deps.stdout)
}

function showHelp (deps: Deps): number {
  deps.stdout(HELP)
  return EXIT_OK
}

function asksHelp (argv: string[]): boolean {
  const end = argv.indexOf('--')
  return (end === -1 ? argv : argv.slice(0, end)).some(a => a === '-h' || a === '--help')
}

/** `ctt completion [bash|zsh]` prints the script; without a shell, $SHELL decides when it is bash or zsh. */
function completion (argv: string[], deps: Deps): number {
  const { positionals } = parseFlags(argv, COMMANDS.completion.flags, { positionals: true })
  if (positionals.length > 1) throw new Error(`Unexpected argument '${positionals[1]}'`)
  const shell = positionals[0] ?? basename(deps.shell ?? '')
  if (!isShell(shell)) {
    const where = positionals[0] === undefined ? ' in $SHELL' : ''
    throw new Error(`unknown shell "${shell}"${where} (supported: ${SHELLS.join(', ')}); run ${SHELLS.map(s => `ctt completion ${s}`).join(' or ')}`)
  }
  deps.stdout(completionScript(shell, deps.completionProgram))
  return EXIT_OK
}

function focus (argv: string[], deps: Deps): number {
  const id = requireId(argv)
  const adapter = deps.resolveAdapter()
  const c = liveWithPanes(deps, adapter).find(x => x.digest.sessionId === id)
  if (c?.pane === undefined || adapter === undefined) {
    deps.stderr(`claude-term-tabs: no reachable pane for session ${id}`)
    return EXIT_NONE
  }
  adapter.focus(c.pane)
  return EXIT_OK
}

function sendStopCommand (argv: string[], deps: Deps): number {
  const id = requireId(argv)
  const adapter = deps.resolveAdapter()
  const c = liveWithPanes(deps, adapter).find(x => x.digest.sessionId === id)
  if (c === undefined) {
    deps.stderr(`claude-term-tabs: session ${id} is not running`)
    return EXIT_NONE
  }
  return sendStop(c, adapter, loadConfig(deps.dirs.config).stopPrompt, deps.stderr, x => frontOf(deps, x)) ? EXIT_OK : EXIT_NONE
}

function frontOf (deps: Deps, c: Candidate): Front {
  return c.tty !== undefined ? inFrontOf(deps.exec, c.tty) : 'other'
}

function requireId (argv: string[]): string {
  const { positionals } = parseFlags(argv, {}, { positionals: true })
  if (positionals.length !== 1) throw new Error('expected exactly one session id')
  return positionals[0]
}

function readSnapshot (path: string): Snapshot {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Snapshot
  } catch (err) {
    throw new Error(`cannot read snapshot ${path}: ${(err as Error).message}`)
  }
}

function positive (raw: string, flag: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number of minutes`)
  return n
}
