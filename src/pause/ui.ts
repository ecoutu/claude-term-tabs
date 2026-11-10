import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { tickPause, stragglerLines, type PauseDeps, type PauseRun } from './run.ts'

/** How often the straggler list refreshes. */
export const POLL_MS = 3000
const CLEAR = '\x1b[2J\x1b[H'
const HEADER = 'ct pause: Enter or double-click jumps to a session · ctrl-r re-sends the stop prompt · Esc stops waiting'

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

/** fzf arguments for the live straggler list; `self` is the argv prefix that re-invokes ct. */
export function fzfArgs (port: number, self: string[]): string[] {
  const ct = self.map(shellQuote).join(' ')
  return [
    '--listen', `127.0.0.1:${port}`,
    '--delimiter', '\t', '--with-nth', '2..',
    '--no-sort', '--layout', 'reverse', '--height', '50%',
    '--prompt', 'waiting> ', '--header', HEADER,
    '--bind', `enter:execute-silent(${ct} _focus {1})`,
    '--bind', `double-click:execute-silent(${ct} _focus {1})`,
    '--bind', `ctrl-r:execute-silent(${ct} _send-stop {1})`
  ]
}

/**
 * Poll the pause every POLL_MS, showing stragglers until none remain (and nothing is still closing),
 * the timeout passes, or the user closes the list. Returns the latest run.
 */
export async function runStragglerUi (run: PauseRun, deps: PauseDeps, io: UiIo, advance: (r: PauseRun, d: PauseDeps) => PauseRun = tickPause): Promise<PauseRun> {
  const deadline = deps.now() + io.timeoutMs
  let current = run
  const ui = io.hasFzf && io.isTty ? await fzfUi(io, stragglerLines(current, deps.now())) : plainUi(io, deps)
  await ui.update(stragglerLines(current, deps.now()))
  while (!ui.closed()) {
    await io.sleep(POLL_MS)
    if (ui.closed()) break
    current = advance(current, deps)
    const lines = stragglerLines(current, deps.now())
    const closing = current.tracked.some(t => t.state === 'closing')
    if ((lines.length === 0 && !closing) || deps.now() >= deadline) break
    await ui.update(lines)
  }
  await ui.finish()
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
  const child = spawn('fzf', fzfArgs(port, io.self), { stdio: ['pipe', 'ignore', 'inherit'] })
  let exited = false
  child.on('exit', () => { exited = true })
  child.on('error', () => { exited = true })
  child.stdin.end(initial.join('\n'))
  const post = async (action: string): Promise<void> => {
    if (exited) return
    try {
      await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: action })
    } catch (err) {
      if (!exited) process.stderr.write(`claude-tabs: could not update the list: ${(err as Error).message}\n`)
    }
  }
  return {
    update: async (lines) => { await post(`reload(printf '%s\\n' ${lines.map(shellQuote).join(' ')})`) },
    finish: async () => {
      await post('abort')
      if (!exited) await new Promise<void>(resolve => child.once('exit', () => resolve()))
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

function shellQuote (s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}
