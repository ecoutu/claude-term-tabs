import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, run, runCommand, type Deps } from '../src/cli.ts'
import { saveSnapshot, type Snapshot } from '../src/snapshot.ts'
import { transcriptPath } from '../src/paths.ts'
import type { TerminalAdapter } from '../src/terminals/adapter.ts'
import type { Exec, Pane } from '../src/types.ts'

interface FakeSession { pid: number, id: string, cwd: string, title: string, tty: string, window?: number, tab: number, live?: boolean }

const SESSIONS: FakeSession[] = [
  { pid: 101, id: 'envoy-id', cwd: '/w/api-proxy', title: 'Envoy api-accounts exposure and staging', tty: 'ttys001', tab: 1 },
  { pid: 102, id: 'csv-a', cwd: '/w/api-orders', title: 'Api-orders-prod CSV ingestion errors', tty: 'ttys002', tab: 2 },
  { pid: 103, id: 'csv-b', cwd: '/w/api-orders', title: 'CSV ingestion merge-failed for zephyrx', tty: 'ttys003', tab: 3 },
  { pid: 0, id: 'old-id', cwd: '/w/gone-repo', title: 'Old cube spike', tty: '', tab: 0, live: false }
]

function world (opts: { windows?: number, claude?: (input: string) => { status: number, stdout: string } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-cli-'))
  const dirs = { sessions: join(root, 'sessions'), projects: join(root, 'projects'), cache: join(root, 'cache', 'd.json'), config: join(root, 'config.json'), snapshots: join(root, 'snapshots') }
  mkdirSync(dirs.sessions)
  for (const s of SESSIONS) {
    const path = transcriptPath(dirs.projects, s.cwd, s.id)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, [JSON.stringify({ type: 'user', cwd: s.cwd, gitBranch: 'main', message: { content: 'hello' } }), JSON.stringify({ type: 'ai-title', aiTitle: s.title })].join('\n') + '\n')
    if (s.live !== false) writeFileSync(join(dirs.sessions, `${s.pid}.json`), JSON.stringify({ pid: s.pid, sessionId: s.id, cwd: s.cwd, status: 'idle', entrypoint: 'cli' }))
  }
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  const exec: Exec = (cmd, args, input) => {
    calls.push(cmd)
    if (cmd === 'ps' && args[0] === '-t') return { status: 0, stdout: ' 50 50 claude\n', stderr: '' }
    if (cmd === 'ps') return { status: 0, stdout: SESSIONS.filter(s => s.live !== false).map(s => `${s.pid} ${s.tty} 10:00 claude`).join('\n'), stderr: '' }
    if (cmd === 'claude' && opts.claude !== undefined) return { ...opts.claude(input ?? ''), stderr: '' }
    return { status: 1, stdout: '', stderr: `unexpected ${cmd}` }
  }
  const focused: string[] = []
  const opened: Array<[string, string]> = []
  const sent: Array<[string, string]> = []
  const panes: Pane[] = SESSIONS.filter(s => s.live !== false).map(s => ({
    id: `pane-${s.id}`, tty: `/dev/${s.tty}`, title: s.title, windowId: 'w', windowIndex: s.tab === 3 ? (opts.windows ?? 1) : 1, tabIndex: s.tab
  }))
  const adapter: TerminalAdapter = {
    name: 'iterm2',
    listPanes: () => panes,
    focus: p => { focused.push(p.id) },
    sendText: (p, text) => { sent.push([p.id, text]) },
    closePane: () => {},
    openPane: (cwd, cmd) => { opened.push([cwd, cmd]); return 'new' }
  }
  let picked: string | undefined
  const deps: Deps = {
    exec,
    execTty: exec,
    dirs,
    stdout: s => out.push(s),
    stderr: s => err.push(s),
    prompt: () => '',
    now: () => Date.now(),
    isTty: true,
    hasFzf: false,
    dirExists: p => !p.includes('gone'),
    resolveAdapter: () => adapter,
    pick: cands => cands.find(c => c.digest.sessionId === picked),
    isAlive: () => true,
    sleep: async () => {},
    self: ['node', 'ct']
  }
  return { deps, calls, out, err, focused, opened, sent, choose: (id: string) => { picked = id } }
}

const haiku = (ids: string[]) => () => ({ status: 0, stdout: JSON.stringify({ structured_output: { matches: ids.map(sessionId => ({ sessionId, summary: `about ${sessionId}` })) } }) })

test('clear local winner focuses its pane without calling claude', () => {
  const w = world()
  assert.equal(run(parseArgs(['envoy', 'api-accounts']), w.deps), 0)
  assert.deepEqual(w.focused, ['pane-envoy-id'])
  assert.equal(w.out.join('\n'), '→ Envoy api-accounts exposure and staging · api-proxy · tab 1')
  assert.ok(!w.calls.includes('claude'))
})

test('window number is shown when more than one window is open', () => {
  const w = world({ windows: 2 })
  run(parseArgs(['zephyrx']), w.deps)
  assert.equal(w.out.join('\n'), '→ CSV ingestion merge-failed for zephyrx · api-orders · window 2 · tab 3')
})

test('--list prints the winner and never focuses', () => {
  const w = world()
  assert.equal(run(parseArgs(['--list', 'envoy']), w.deps), 0)
  assert.deepEqual(w.focused, [])
  assert.match(w.out.join('\n'), /Envoy api-accounts exposure and staging · api-proxy/)
})

test('filler-only query opens the picker over all live sessions', () => {
  const w = world()
  let offered: string[] = []
  w.deps.pick = cands => { offered = cands.map(c => c.digest.sessionId); return cands[0] }
  run(parseArgs(['working', 'on', 'the', 'session']), w.deps)
  assert.deepEqual([...offered].sort(), ['csv-a', 'csv-b', 'envoy-id'])
  assert.ok(!w.calls.includes('claude'))
})

test('--all with no query offers closed sessions too', () => {
  const w = world()
  let offered: string[] = []
  w.deps.pick = cands => { offered = cands.map(c => c.digest.sessionId); return undefined }
  run(parseArgs(['--all']), w.deps)
  assert.deepEqual([...offered].sort(), ['csv-a', 'csv-b', 'envoy-id', 'old-id'])
})

test('ambiguous query asks haiku; a single id switches', () => {
  const w = world({ claude: haiku(['csv-b']) })
  assert.equal(run(parseArgs(['csv', 'ingestion']), w.deps), 0)
  assert.deepEqual(w.focused, ['pane-csv-b'])
})

test('ambiguous query with several haiku matches opens the picker in haiku order', () => {
  const w = world({ claude: haiku(['csv-b', 'csv-a']) })
  let offered: string[] = []
  w.deps.pick = (cands, summaries) => { offered = cands.map(c => `${c.digest.sessionId}:${summaries.get(c.digest.sessionId) ?? ''}`); return cands[1] }
  run(parseArgs(['csv', 'ingestion']), w.deps)
  assert.deepEqual(offered, ['csv-b:about csv-b', 'csv-a:about csv-a'])
  assert.deepEqual(w.focused, ['pane-csv-a'])
})

test('haiku failure falls back to the local ranking with a warning', () => {
  const w = world({ claude: () => ({ status: 1, stdout: '' }) })
  let offered = 0
  w.deps.pick = cands => { offered = cands.length; return undefined }
  assert.equal(run(parseArgs(['csv', 'ingestion']), w.deps), 1)
  assert.equal(offered, 2)
  assert.match(w.err.join('\n'), /using local ranking/)
})

test('--no-llm never calls claude', () => {
  const w = world()
  w.choose('csv-a')
  run(parseArgs(['--no-llm', 'csv', 'ingestion']), w.deps)
  assert.ok(!w.calls.includes('claude'))
  assert.deepEqual(w.focused, ['pane-csv-a'])
})

test('no adapter lists the match with its tty', () => {
  const w = world()
  w.deps.resolveAdapter = () => undefined
  assert.equal(run(parseArgs(['envoy']), w.deps), 0)
  assert.match(w.out.join('\n'), /Envoy api-accounts exposure and staging .*\/dev\/ttys001/)
})

test('no match suggests --all', () => {
  const w = world({ claude: haiku([]) })
  assert.equal(run(parseArgs(['kubernetes']), w.deps), 1)
  assert.equal(w.out.join('\n'), 'No matching sessions. Try --all.')
})

test('--all finds a closed session whose directory is gone and explains why it cannot resume', () => {
  const w = world()
  w.choose('old-id')
  assert.equal(run(parseArgs(['--all', '--no-llm', 'cube']), w.deps), 1)
  assert.deepEqual(w.opened, [])
  assert.match(w.out.join('\n'), /no longer exists/)
  assert.match(w.out.join('\n'), /claude --resume old-id/)
})

test('--all resumes a closed session in a new pane once it is chosen', () => {
  const w = world()
  w.deps.dirExists = () => true
  w.choose('old-id')
  assert.equal(run(parseArgs(['--all', '--no-llm', 'cube']), w.deps), 0)
  assert.deepEqual(w.opened, [['/w/gone-repo', 'claude --resume old-id']])
})

test('--json prints a JSON array and implies --list', () => {
  const w = world()
  assert.equal(run(parseArgs(['--json', 'envoy']), w.deps), 0)
  const parsed = JSON.parse(w.out.join('\n')) as Array<{ sessionId: string, tab?: number }>
  assert.equal(parsed[0].sessionId, 'envoy-id')
  assert.equal(parsed[0].tab, 1)
  assert.deepEqual(w.focused, [])
})

test('unknown flag is a usage error', () =>
  assert.throws(() => parseArgs(['--bogus']), /bogus/))

test('invalid config is an error, not an empty config', () => {
  const w = world()
  writeFileSync(w.deps.dirs.config, '{nope')
  w.deps.dirExists = () => true
  assert.equal(run(parseArgs(['--all', '--no-llm', 'cube']), w.deps), 2)
  assert.match(w.err.join('\n'), /config/)
})

test('a weak single local hit opens the picker instead of switching', () => {
  const w = world()
  let offered: string[] = []
  w.deps.pick = cands => { offered = cands.map(c => c.digest.sessionId); return undefined }
  assert.equal(run(parseArgs(['--no-llm', 'envo']), w.deps), 1)
  assert.deepEqual(offered, ['envoy-id'])
  assert.deepEqual(w.focused, [])
})

test('a clear local winner that is closed is offered, not resumed', () => {
  const w = world()
  w.deps.dirExists = () => true
  assert.equal(run(parseArgs(['--all', '--no-llm', 'cube']), w.deps), 1)
  assert.deepEqual(w.opened, [])
})

test('haiku returning only unknown ids falls back to the local ranking', () => {
  const w = world({ claude: haiku(['bogus']) })
  let offered = 0
  w.deps.pick = cands => { offered = cands.length; return undefined }
  run(parseArgs(['csv', 'ingestion']), w.deps)
  assert.equal(offered, 2)
  assert.match(w.err.join('\n'), /using local ranking/)
})

test('no local match with haiku down says so instead of no matches', () => {
  const w = world({ claude: () => ({ status: 1, stdout: '' }) })
  assert.equal(run(parseArgs(['kubernetes']), w.deps), 1)
  assert.doesNotMatch(w.out.join('\n'), /No matching sessions/)
  assert.match(w.out.join('\n'), /Haiku was unavailable/)
})

test('ct pause types the stop prompt into every live session and reports stragglers', async () => {
  const w = world()
  w.deps.isTty = false
  const code = await runCommand(['pause', '--timeout', '0.001'], w.deps)
  assert.equal(code, 1)
  assert.deepEqual(w.sent.map(x => x[0]).sort(), ['pane-csv-a', 'pane-csv-b', 'pane-envoy-id'])
  assert.match(w.sent[0][1], /Pausing for a machine restart/)
  assert.match(w.out.join('\n'), /0 of 3 sessions wrote a HANDOFF/)
})

test('ct resume --dry-run prints commands from the latest snapshot and skips live sessions', async () => {
  const w = world()
  const snap: Snapshot = { id: '2026-11-10T00-00-00.000Z', createdAt: '2026-11-10T00:00:00.000Z', sessions: [
    { sessionId: 'envoy-id', cwd: '/w/api-proxy', repo: 'api-proxy', windowIndex: 1, tabIndex: 1, handoffWritten: true },
    { sessionId: 'old-id', cwd: '/w/old', repo: 'old', windowIndex: 1, tabIndex: 2, handoffWritten: true }
  ] }
  saveSnapshot(w.deps.dirs.snapshots, snap)
  w.deps.dirExists = () => true
  assert.equal(await runCommand(['resume', '--dry-run', '--no-prompt'], w.deps), 0)
  const text = w.out.join('\n')
  assert.match(text, /already running/)
  assert.match(text, /cd '\/w\/old' && claude --resume old-id/)
  assert.deepEqual(w.opened, [])
})

test('ct resume without a snapshot says so', async () => {
  const w = world()
  assert.equal(await runCommand(['resume'], w.deps), 1)
  assert.match(w.out.join('\n'), /No snapshot found/)
})

test('_focus jumps to a live session by id', async () => {
  const w = world()
  assert.equal(await runCommand(['_focus', 'csv-b'], w.deps), 0)
  assert.deepEqual(w.focused, ['pane-csv-b'])
})

test('_send-stop types the stop prompt into one session', async () => {
  const w = world()
  assert.equal(await runCommand(['_send-stop', 'csv-a'], w.deps), 0)
  assert.deepEqual(w.sent.map(x => x[0]), ['pane-csv-a'])
})

test('a search query is not a subcommand, and -- forces a search', async () => {
  const w = world()
  assert.equal(await runCommand(['envoy'], w.deps), undefined)
  assert.equal(await runCommand(['--', 'pause'], w.deps), undefined)
  assert.equal(parseArgs(['--', 'pause']).query, 'pause')
})

test('unknown flags on subcommands are usage errors', async () => {
  const w = world()
  assert.equal(await runCommand(['pause', '--bogus'], w.deps), 2)
  assert.equal(await runCommand(['resume', '--bogus'], w.deps), 2)
  assert.match(w.err.join('\n'), /bogus/)
})
