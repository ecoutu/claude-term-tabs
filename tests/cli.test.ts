import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completionProgram, completionWarning, main, parseArgs, realDeps, run, runCommand, type Deps } from '../src/cli.ts'
import { flagLines, HELP } from '../src/help.ts'
import { entry } from '../src/args.ts'
import { spawnSync } from 'node:child_process'
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
  const root = mkdtempSync(join(tmpdir(), 'ctt-cli-'))
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
    self: ['node', 'ctt'],
    completionProgram: 'ctt',
    completionWarning: () => undefined,
    shell: '/bin/bash'
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

test('--all leaves out closed sessions in excludeDirs', () => {
  const before = world()
  assert.equal(run(parseArgs(['--all', '--list', '--no-llm', 'cube']), before.deps), 0)
  assert.match(before.out.join('\n'), /Old cube spike/)
  const w = world()
  writeFileSync(w.deps.dirs.config, JSON.stringify({ excludeDirs: ['/w/gone-repo'] }))
  assert.equal(run(parseArgs(['--all', '--list', '--no-llm', 'cube']), w.deps), 1)
  assert.doesNotMatch(w.out.join('\n'), /Old cube spike/)
  assert.match(w.out.join('\n'), /No matching sessions\./)
})

test('excludeDirs never hides a live session', () => {
  const w = world()
  writeFileSync(w.deps.dirs.config, JSON.stringify({ excludeDirs: ['/w/api-proxy'] }))
  assert.equal(run(parseArgs(['--all', '--list', '--no-llm', 'envoy']), w.deps), 0)
  assert.match(w.out.join('\n'), /Envoy api-accounts/)
})

test('--json prints a JSON array and implies --list', () => {
  const w = world()
  assert.equal(run(parseArgs(['--json', 'envoy']), w.deps), 0)
  const parsed = JSON.parse(w.out.join('\n')) as Array<{ sessionId: string, tab?: number }>
  assert.equal(parsed[0].sessionId, 'envoy-id')
  assert.equal(parsed[0].tab, 1)
  assert.deepEqual(w.focused, [])
})

test('--help lists the pause and resume subcommands and their flags', () => {
  const w = world()
  assert.equal(run(parseArgs(['--help']), w.deps), 0)
  const help = w.out.join('\n')
  for (const s of ['ctt pause', '--auto-close', '--timeout', 'ctt resume', '--dry-run', '--no-prompt', '--snapshot']) assert.ok(help.includes(s), s)
})

test('-h and --help on pause and resume print the help without pausing or resuming', async () => {
  for (const argv of [['pause', '-h'], ['pause', '--help'], ['resume', '-h'], ['resume', '--help'], ['pause', '-h', '--bogus'], ['resume', 'extra', '--help']]) {
    const w = world()
    assert.equal(await runCommand(argv, w.deps), 0)
    assert.deepEqual(w.out, [HELP])
    assert.deepEqual(w.err, [])
    assert.deepEqual(w.sent, [])
    assert.deepEqual(w.opened, [])
  }
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

test('ctt pause types the stop prompt into every live session and reports stragglers', async () => {
  const w = world()
  w.deps.isTty = false
  const code = await runCommand(['pause', '--timeout', '0.001'], w.deps)
  assert.equal(code, 1)
  assert.deepEqual(w.sent.map(x => x[0]).sort(), ['pane-csv-a', 'pane-csv-b', 'pane-envoy-id'])
  assert.match(w.sent[0][1], /Pausing for a machine restart/)
  assert.match(w.out.join('\n'), /0 of 3 sessions wrote a HANDOFF/)
})

test('ctt resume --dry-run prints commands from the latest snapshot and skips live sessions', async () => {
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

test('ctt resume without a snapshot says so', async () => {
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
  assert.equal(await runCommand(['pause', '--', '-h'], w.deps), 2)
  assert.equal(await runCommand(['resume', '--', '-h'], w.deps), 2)
  assert.match(w.err.join('\n'), /bogus/)
})

test('numbers in a query stay text and flags may follow it', () => {
  const opts = parseArgs(['pr', '0123', '--no-llm', '--terminal', 'wezterm'])
  assert.equal(opts.query, 'pr 0123')
  assert.equal(opts.noLlm, true)
  assert.equal(opts.terminal, 'wezterm')
  assert.equal(opts.list, false)
  assert.equal(parseArgs(['-h']).help, true)
})

test('a word after a boolean flag stays in the query, and boolean flags take no value', () => {
  assert.equal(parseArgs(['--list', 'true', 'story']).query, 'true story')
  assert.equal(parseArgs(['--no-llm', 'false']).query, 'false')
  assert.throws(() => parseArgs(['--list=false']), /list/)
})

test('subcommands reject stray words', async () => {
  const w = world()
  assert.equal(await runCommand(['pause', 'now'], w.deps), 2)
  assert.equal(await runCommand(['resume', '--dry-run', 'now'], w.deps), 2)
  assert.match(w.err.join('\n'), /now/)
})

test('--terminal without a name is a usage error', () =>
  assert.throws(() => parseArgs(['--terminal']), /terminal/))

async function complete (words: string[], shell = '/bin/bash'): Promise<string[]> {
  const w = world()
  assert.equal(await runCommand(['--complete', shell.includes('zsh') ? 'zsh' : 'bash', 'ctt', ...words], w.deps), 0)
  return w.out.join('\n').split('\n').filter(s => s !== '')
}

test('completion offers the public subcommands and never the internal ones', async () => {
  const words = await complete([''])
  for (const cmd of ['pause', 'resume', 'completion']) assert.ok(words.includes(cmd), `${cmd} in ${words.join(' ')}`)
  assert.deepEqual(words.filter(s => s.startsWith('_')), [])
  assert.deepEqual((await complete(['_'])).filter(s => s.startsWith('_')), [])
})

test('completion offers the search flags after ctt', async () => {
  const words = await complete(['--'])
  for (const flag of ['--list', '--all', '--json', '--no-llm', '--terminal', '--help']) assert.ok(words.includes(flag), `${flag} in ${words.join(' ')}`)
  assert.ok(!words.some(s => s.includes('_focus') || s.includes('_send-stop')))
})

test('completion offers each subcommand its own flags', async () => {
  assert.deepEqual((await complete(['pause', '--'])).sort(), ['--auto-close', '--help', '--timeout'])
  assert.deepEqual((await complete(['resume', '--'])).sort(), ['--dry-run', '--help', '--no-prompt', '--snapshot'])
  assert.deepEqual(await complete(['completion', '-']), ['--help'])
})

test('completion offers the terminal names after --terminal', async () => {
  assert.deepEqual((await complete(['--terminal', ''])).sort(), ['iterm2', 'wezterm'])
  assert.deepEqual(await complete(['--list', '--terminal', 'w']), ['wezterm'])
})

test('zsh completion describes each subcommand', async () => {
  const words = await complete([''], '/bin/zsh')
  assert.ok(words.some(s => /^pause:\S/.test(s)), words.join(' '))
})

async function script (argv: string[], shell = '/bin/bash', self = 'ctt'): Promise<{ code?: number, out: string, err: string }> {
  const w = world()
  w.deps.self = ['node', self]
  w.deps.completionProgram = self
  w.deps.shell = shell === '' ? undefined : shell
  const code = await runCommand(argv, w.deps)
  return { code, out: w.out.join('\n'), err: w.err.join('\n') }
}

test('ctt completion bash and zsh print a script that completes both ctt and claude-term-tabs', async () => {
  const bash = await script(['completion', 'bash'], '/bin/zsh', '/home/u/bin/claude-term-tabs')
  assert.equal(bash.code, 0)
  assert.match(bash.out, /^complete .*-F _ctt_completions ctt claude-term-tabs$/m)
  assert.match(bash.out, /'\/home\/u\/bin\/claude-term-tabs' --complete bash /)
  const zsh = await script(['completion', 'zsh'], '/bin/bash', '/home/u/bin/ctt')
  assert.equal(zsh.code, 0)
  assert.match(zsh.out, /^#compdef ctt claude-term-tabs$/m)
  assert.match(zsh.out, /compdef _ctt_completions ctt claude-term-tabs/)
  assert.match(zsh.out, /'\/home\/u\/bin\/ctt' --complete zsh /)
  assert.match(zsh.out, /compset -P '\*='\n\s*_default/)
})

test('an installed ctt completes through its command name, so a cleaned or version-switched install path does not break it', () => {
  assert.equal(completionProgram('/home/u/.npm/_npx/abc/node_modules/.bin/ctt', true), 'claude-term-tabs')
  assert.equal(completionProgram('/home/u/.nvm/versions/node/v24.1.0/bin/ctt', true), 'claude-term-tabs')
})

test('a clone completes through its own path, so it works off PATH', () =>
  assert.equal(completionProgram('/home/u/src/claude-tabs/bin/claude-term-tabs', false), '/home/u/src/claude-tabs/bin/claude-term-tabs'))

test('realDeps completes through the command name only when the launcher says it runs installed', () => {
  assert.equal(realDeps(undefined, true).completionProgram, 'claude-term-tabs')
  assert.equal(realDeps().completionProgram, process.argv[1])
})

test('ctt completion writes the completion program into the script', async () => {
  const w = world()
  w.deps.completionProgram = 'claude-term-tabs'
  assert.equal(await runCommand(['completion', 'bash'], w.deps), 0)
  assert.match(w.out.join('\n'), /'claude-term-tabs' --complete bash /)
})

test('an installed ctt warns only when no lasting PATH entry has claude-term-tabs', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p)
  const PATH = '/home/u/.npm/_npx/abc/node_modules/.bin:/proj/node_modules/.bin:/usr/local/bin:/usr/bin'
  // npx alone, or a project-local install: only throwaway entries have it.
  assert.match(completionWarning('claude-term-tabs', PATH, has('/home/u/.npm/_npx/abc/node_modules/.bin/claude-term-tabs')) ?? '',
    /npm install --global claude-term-tabs/)
  assert.match(completionWarning('claude-term-tabs', PATH, has('/proj/node_modules/.bin/claude-term-tabs')) ?? '', /npm install --global/)
  // A global install, whether run as ctt from its own bin dir or through npx.
  assert.equal(completionWarning('claude-term-tabs', PATH, has('/usr/local/bin/ctt', '/usr/local/bin/claude-term-tabs')), undefined)
  // A clone's script calls its own path, so PATH doesn't matter.
  assert.equal(completionWarning('/home/u/src/ctt/bin/claude-term-tabs', PATH, has()), undefined)
})

test('ctt completion prints the script and puts any warning on stderr', async () => {
  const w = world()
  w.deps.completionProgram = 'claude-term-tabs'
  w.deps.completionWarning = program => `${program}: install it`
  assert.equal(await runCommand(['completion', 'bash'], w.deps), 0)
  assert.match(w.out.join('\n'), /'claude-term-tabs' --complete bash /)
  assert.deepEqual(w.err, ['claude-term-tabs: install it'])
})

test('ctt completion without a shell picks it from $SHELL', async () => {
  assert.match((await script(['completion'], '/usr/bin/zsh')).out, /^#compdef ctt claude-term-tabs$/m)
  assert.match((await script(['completion'], '/bin/bash')).out, /^complete /m)
})

test('ctt completion without a shell refuses a $SHELL that is not bash or zsh', async () => {
  for (const shell of ['/usr/bin/fish', '']) {
    const r = await script(['completion'], shell)
    assert.equal(r.code, 2, shell)
    assert.equal(r.out, '')
    assert.match(r.err, /unknown shell.*ctt completion bash.*ctt completion zsh/)
  }
})

test('ctt completion rejects other shells, extra words and unknown flags, and -h prints the help', async () => {
  for (const argv of [['completion', 'fish'], ['completion', 'bash', 'zsh'], ['completion', 'pause'], ['completion', '--bogus']]) {
    const r = await script(argv)
    assert.equal(r.code, 2, argv.join(' '))
    assert.equal(r.out, '', argv.join(' '))
  }
  for (const argv of [['completion', '-h'], ['completion', 'zsh', '--help']]) assert.deepEqual(await script(argv), { code: 0, out: HELP, err: '' })
})

test('--help lists ctt completion', () => assert.match(HELP, /ctt completion \[bash\|zsh\]/))

test('the completion query flag is an unknown flag everywhere but as the first word', async () => {
  for (const argv of [['pause', '--complete'], ['resume', '--dry-run', '--complete', 'bash', 'ctt'], ['completion', '--complete']]) {
    const w = world()
    assert.equal(await runCommand(argv, w.deps), 2, argv.join(' '))
    assert.deepEqual(w.out, [], argv.join(' '))
    assert.deepEqual(w.sent, [])
    assert.match(w.err.join('\n'), /--complete/)
  }
  assert.throws(() => parseArgs(['foo', '--complete']), /--complete/)
  assert.equal(await runCommand(['--complete', 'fish', 'ctt', ''], world().deps), 2)
  assert.equal(await runCommand(['--complete'], world().deps), 2)
})

/** Run the real entry point, capturing what it writes to stderr. */
async function mainExit (argv: string[]): Promise<{ code: number, err: string }> {
  const write = process.stderr.write
  let err = ''
  process.stderr.write = ((s: string) => { err += s; return true }) as typeof process.stderr.write
  try {
    return { code: await main(argv), err }
  } finally {
    process.stderr.write = write
  }
}

test('odd flags are node:util usage errors that exit 2', async () => {
  for (const argv of [['-1'], ['--h'], ['-_'], ['-h0'], ['--_'], ['--$0', 'x'], ['x', '--complete', 'bash'], ['--list=false']]) {
    const r = await mainExit(argv)
    assert.equal(r.code, 2, argv.join(' '))
    assert.match(r.err, /^claude-term-tabs: (Unknown option|Option)/, argv.join(' '))
  }
  const w = world()
  for (const argv of [['pause', '-1'], ['pause', '--h'], ['resume', '-h0'], ['resume', '-_'], ['completion', '--h']]) assert.equal(await runCommand(argv, w.deps), 2, argv.join(' '))
  assert.equal(parseArgs(['-h']).help, true)
  assert.equal(parseArgs(['x', '--help']).help, true)
})

test('subcommands are completed only as the first word', async () => {
  for (const words of [['fix', ''], ['--list', ''], ['-h', ''], ['--', ''], ['--', '--'], ['completion', ''], ['pause', ''], ['resume', '--dry-run', '']]) {
    const offered = (await complete(words)).filter(s => ['pause', 'resume', 'completion'].includes(s.split(':')[0]))
    assert.deepEqual(offered, [], words.join(' '))
  }
  assert.deepEqual(await complete(['--', '--']), [])
  assert.deepEqual(await complete(['--', '--'], '/bin/zsh'), [])
})

test('flags that take a value complete their values or nothing', async () => {
  assert.deepEqual(await complete(['resume', '--snapshot', '']), [])
  assert.deepEqual(await complete(['resume', '--snapshot', 'snap']), [])
  assert.deepEqual(await complete(['pause', '--timeout', '']), [])
  assert.deepEqual(await complete(['--terminal', ''], '/bin/zsh'), ['iterm2', 'wezterm'])
  assert.deepEqual(await complete(['--terminal', '=']), ['iterm2', 'wezterm'])
  assert.deepEqual(await complete(['--terminal', '=', 'i']), ['iterm2'])
  assert.deepEqual(await complete(['--terminal=w'], '/bin/zsh'), ['--terminal=wezterm'])
  assert.deepEqual(await complete(['resume', '--snapshot=sn'], '/bin/zsh'), [])
  assert.deepEqual(await complete(['pause', '--timeout=1'], '/bin/zsh'), [])
})

test('ctt completion completes the shell names', async () => {
  assert.deepEqual(await complete(['completion', '']), ['bash', 'zsh'])
  assert.deepEqual(await complete(['completion', 'z']), ['zsh'])
  assert.deepEqual(await complete(['completion', 'zsh', '']), [])
})

test('zsh completion describes every flag and subcommand in the words of --help', async () => {
  const lines = [...await complete([''], '/bin/zsh'), ...await complete(['--'], '/bin/zsh'), ...await complete(['pause', '--'], '/bin/zsh'), ...await complete(['resume', '--'], '/bin/zsh')]
  assert.equal(lines.length, 16, lines.join('\n'))
  for (const line of lines) {
    const desc = line.slice(line.indexOf(':') + 1)
    assert.ok(desc !== '' && HELP.includes(desc), `${line} not in --help`)
  }
})

test('building the real deps runs nothing until the picker needs fzf', () => {
  const calls: string[] = []
  const deps = realDeps((cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } })
  assert.deepEqual(calls, [])
  assert.equal(deps.hasFzf, true)
  assert.equal(deps.hasFzf, true)
  assert.deepEqual(calls, ['sh -c command -v fzf'])
})

test('flags already given are not offered again, whatever form they were given in', async () => {
  const cases: Array<[string[], string[], string]> = [
    [['--terminal=iterm2', '--'], ['--terminal=iterm2', '--'], '--terminal'],
    [['--terminal', 'iterm2', '--'], ['--terminal', '=', 'iterm2', '--'], '--terminal'],
    [['resume', '--snapshot=f', '--'], ['resume', '--snapshot', '=', 'f', '--'], '--snapshot'],
    [['-h', '--'], ['-h', '--'], '--help'],
    [['pause', '-h', '--'], ['pause', '-h', '--'], '--help']
  ]
  for (const [zshWords, bashWords, flag] of cases) {
    const zsh = (await complete(zshWords, '/bin/zsh')).map(s => s.split(':')[0])
    const bash = await complete(bashWords)
    assert.ok(zsh.length > 0 && !zsh.includes(flag), `zsh ${zshWords.join(' ')}: ${zsh.join(' ')}`)
    assert.ok(bash.length > 0 && !bash.includes(flag), `bash ${bashWords.join(' ')}: ${bash.join(' ')}`)
  }
})

test('zsh completion escapes colons in every word it offers', () => {
  assert.equal(entry('zsh', 'a:b', 'say: hi'), 'a\\:b:say: hi')
  assert.equal(entry('zsh', 'a:b'), 'a\\:b')
  assert.equal(entry('bash', 'a:b', 'say: hi'), 'a:b')
})

test('a completion request answers without loading the rest of ctt', () => {
  const hook = 'data:text/javascript,import{registerHooks}from"node:module";registerHooks({resolve(s,c,n){const r=n(s,c);process.stderr.write("loaded "+r.url+"\\n");return r}})'
  const r = spawnSync(process.execPath, ['--import', hook, join(import.meta.dirname, '..', 'bin', 'claude-term-tabs'), '--complete', 'bash', 'ctt', '--'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n'), ['--list', '--all', '--json', '--no-llm', '--terminal', '--help'])
  const loaded = r.stderr.split('\n').filter(l => l.includes('/src/')).map(l => l.slice(l.indexOf('/src/') + 1))
  assert.ok(loaded.length > 0, r.stderr)
  assert.deepEqual(loaded.filter(f => ['src/cli.ts', 'src/commands.ts', 'src/help.ts'].includes(f)), [], loaded.join(' '))
})

test('the flag column fits the longest label', () => {
  const lines = flagLines({ 'a-very-long-flag-name': { value: 'SOMETHING', describe: 'first' }, x: { describe: 'second' } }).split('\n')
  assert.deepEqual(lines, ['  --a-very-long-flag-name SOMETHING  first', `  --x${' '.repeat(32)}second`])
  assert.equal(flagLines({ list: { describe: 'd' } }), '  --list           d')
})

test('--help starts with usage lines built from the subcommand tables', () => {
  assert.ok(HELP.startsWith(`usage: ctt [query...] [options]
       ctt pause [--auto-close] [--timeout MIN]
       ctt resume [--dry-run] [--no-prompt] [--snapshot FILE]
       ctt completion [bash|zsh]

Find a Claude Code session`), HELP)
})
