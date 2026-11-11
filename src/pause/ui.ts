import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOwnerOnly } from '../fsutil.ts'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { tickPause, stragglerLines, type PauseDeps, type PauseRun } from './run.ts'
import { FINAL_STATES } from './state.ts'
import { shellQuote } from '../shell.ts'

/** How often the straggler list refreshes. */
export const POLL_MS = 3000
const CLEAR = '\x1b[2J\x1b[H'
const SAFE_PATH = /^[A-Za-z0-9._\/-]+$/
const HEADER = 'ctt pause: Enter or double-click jumps to a session · ctrl-r re-sends the stop prompt · Esc stops waiting'

/** Interactive surroundings of the straggler list. */
export interface UiIo {
  hasFzf: boolean
  isTty: boolean
  timeoutMs: number
  self: string[]
  write: (s: string) => void
  sleep: (ms: number) => Promise<void>
  onPick?: (sessionId: string) => void
}

interface Ui {
  update: (lines: string[]) => Promise<void>
  finish: () => Promise<void>
  closed: () => boolean
}

/** fzf arguments for the live straggler list; `self` is the argv prefix that re-invokes ctt. */
export function fzfArgs (port: number, self: string[]): string[] {
  const ctt = self.map(shellQuote).join(' ')
  return [
    '--listen', `127.0.0.1:${port}`,
    '--delimiter', '\t', '--with-nth', '2..',
    '--no-sort', '--layout', 'reverse', '--height', '50%',
    '--prompt', 'waiting> ', '--header', HEADER,
    '--bind', `enter:execute-silent(${ctt} _focus {1})`,
    '--bind', `double-click:execute-silent(${ctt} _focus {1})`,
    '--bind', `ctrl-r:execute-silent(${ctt} _send-stop {1})`
  ]
}

/** The fzf reload action: it names only a ctt-chosen file, so no session data reaches fzf's action parser. */
export function reloadAction (linesFile: string): string {
  if (!SAFE_PATH.test(linesFile)) throw new Error(`unsafe list file path: ${linesFile}`)
  return `reload(cat ${shellQuote(linesFile)})`
}

/** Environment for fzf with a fresh random FZF_API_KEY, which fzf then requires on every --listen request. */
export function fzfEnv (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, FZF_API_KEY: randomBytes(32).toString('hex') }
}

/**
 * Poll the pause every POLL_MS, showing stragglers until none remain (and nothing is still closing),
 * the timeout passes, or the user closes the list. Returns the latest run.
 */
export async function runStragglerUi (run: PauseRun, deps: PauseDeps, io: UiIo, advance: (r: PauseRun, d: PauseDeps) => PauseRun = tickPause): Promise<PauseRun> {
  const deadline = deps.now() + io.timeoutMs
  let current = run
  const ui = io.hasFzf && io.isTty && process.env.CTT_NO_REAL_EXEC !== '1' ? await fzfUi(io, stragglerLines(current, deps.now())) : plainUi(io, deps)
  try {
    await ui.update(stragglerLines(current, deps.now()))
    while (!ui.closed()) {
      await io.sleep(POLL_MS)
      if (ui.closed()) break
      try {
        current = advance(current, deps)
      } catch (err) {
        deps.warn(`claude-term-tabs: refresh failed, retrying: ${(err as Error).message}`)
        continue
      }
      const pending = current.tracked.some(t => !FINAL_STATES.has(t.state))
      if (!pending || deps.now() >= deadline) break
      await ui.update(stragglerLines(current, deps.now()))
    }
  } finally {
    await ui.finish()
  }
  return current
}

function plainUi (io: UiIo, deps: PauseDeps): Ui {
  let last = ''
  let shown: string[] = []
  const input = io.isTty && io.onPick !== undefined ? createInterface({ input: process.stdin }) : undefined
  input?.on('line', answer => {
    const id = shown[Number(answer.trim()) - 1]
    if (id !== undefined) io.onPick?.(id)
  })
  return {
    update: async (lines) => {
      shown = lines.map(l => l.split('\t')[0])
      const body = lines.map((l, i) => `${String(i + 1).padStart(2)}) ${l.split('\t')[1]}`).join('\n')
      if (io.isTty) {
        io.write(`${CLEAR}Waiting for ${lines.length} sessions (${new Date(deps.now()).toLocaleTimeString()}). Type a number and Enter to jump.\n${body}`)
      } else if (body !== last) {
        io.write(body)
      }
      last = body
    },
    finish: async () => { input?.close() },
    closed: () => false
  }
}

async function fzfUi (io: UiIo, initial: string[]): Promise<Ui> {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'claude-term-tabs-'))
  const linesFile = join(dir, 'lines')
  writeOwnerOnly(linesFile, initial.join('\n'))
  const env = fzfEnv(process.env)
  const child = spawn('fzf', fzfArgs(port, io.self), { stdio: ['pipe', 'ignore', 'inherit'], env })
  let exited = false
  child.on('exit', () => { exited = true })
  child.on('error', () => { exited = true })
  child.stdin.end(initial.join('\n'))
  const post = async (action: string): Promise<void> => {
    if (exited) return
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'x-api-key': env.FZF_API_KEY ?? '' }, body: action })
      if (!res.ok) process.stderr.write(`claude-term-tabs: the list refused an update (${res.status})\n`)
    } catch (err) {
      if (!exited) process.stderr.write(`claude-term-tabs: could not update the list: ${(err as Error).message}\n`)
    }
  }
  return {
    update: async (lines) => {
      writeOwnerOnly(linesFile, lines.join('\n'))
      await post(reloadAction(linesFile))
    },
    finish: async () => {
      await post('abort')
      if (!exited) await new Promise<void>(resolve => child.once('exit', () => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
    closed: () => exited
  }
}

function freePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port)
        else reject(new Error('could not pick a port for fzf'))
      })
    })
  })
}
