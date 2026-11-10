# claude-tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `ct "<phrase>"` CLI that finds Claude Code sessions by what you remember and switches to their terminal tab.

**Architecture:** Pure TypeScript modules (session collection, transcript digests, scoring, Haiku fallback) behind a thin CLI. Terminals plug in through a `TerminalAdapter`; side effects (`ps`, `osascript`, `wezterm`, `claude`, `fzf`) go through an injected `Exec` so every module is testable with fakes.

**Tech Stack:** Node 26 native TypeScript, `node:test`, `node:assert/strict`, no npm dependencies. `fzf` optional.

**Spec:** `docs/superpowers/specs/2026-11-10-claude-tabs-design.md`

## Global Constraints

- Node 26, `.ts` run directly; erasable syntax only (no `enum`, `namespace`, parameter properties); sibling imports use the `.ts` extension.
- Zero npm dependencies. `package.json` exists only for `"type": "module"` and the `test` script.
- No code comments except JSDoc on exported functions/types.
- No em dashes anywhere (code, copy, docs, commits).
- Commits: conventional (`feat:`, `test:`, `docs:`), no co-author or other trailers.
- Errors never read as empty results: a failed read/exec is an error or a stderr warning, never `[]`.
- Cache: `~/.cache/claude-tabs/digests.json`. Config: `~/.config/claude-tabs/config.json`.
- Haiku calls must pass `--no-session-persistence`.

## Review Focus

1. A transcript whose last line is half-written (session busy) must still produce a digest; the bad line is skipped.
2. A stale `~/.claude/sessions/<pid>.json` whose pid now belongs to a non-Claude process must be ignored.
3. A query that is all filler words ("working on the session") behaves like no query: picker over all live sessions.
4. Titles containing tabs, quotes or emoji (iTerm2 names start with `✳`) must not break the fzf line or the selected id.
5. `claude` missing from PATH or failing auth falls back to the local ranking with a warning, never "no matches".

---

## File Structure

```
bin/claude-tabs                 node shim: exec src/cli.ts
src/types.ts                    shared types
src/exec.ts                     Exec type + real implementation (child_process.spawnSync)
src/paths.ts                    repoName, transcriptPath, home-relative dirs
src/transcript.ts               extractDigest (head/tail reading)
src/cache.ts                    DigestCache
src/live.ts                     collectLiveSessions (sessions dir + ps)
src/history.ts                  listClosedSessions (--all)
src/score.ts                    tokenize, scoreDigest, rankLocal, clearWinner
src/llm.ts                      buildHaikuRequest, parseHaikuRanking, askHaiku
src/terminals/adapter.ts        TerminalAdapter, Pane, detectAdapter
src/terminals/iterm2.ts         JXA adapter
src/terminals/wezterm.ts        wezterm cli adapter
src/picker.ts                   formatPickerLine, parsePickerSelection, pick
src/cli.ts                      parseArgs, run
tests/*.test.ts                 one per src module; tests/fixtures/ for JSONL and JSON
```

## Shared types (`src/types.ts`, Task 1)

```ts
export type Status = 'idle' | 'busy' | 'shell' | 'unknown'

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

export interface Candidate {
  digest: Digest
  live: boolean
  status: Status
  tty?: string
  pane?: Pane
  dirGone?: boolean
}

export type Exec = (cmd: string, args: string[], input?: string) =>
  { status: number, stdout: string, stderr: string }
```

```ts
export interface Pane { id: string, tty: string, title: string, windowId: string, windowIndex: number, tabIndex: number }
```

`src/terminals/adapter.ts` imports `Pane` from here.

---

### Task 1: Scaffold, paths and repo naming

**Files:**
- Create: `package.json`, `src/types.ts`, `src/exec.ts`, `src/paths.ts`, `bin/claude-tabs`, `.gitignore`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces: `repoName(cwd: string): { repo: string, worktree?: string }`, `transcriptPath(projectsDir: string, cwd: string, sessionId: string): string`, `realExec: Exec`, all types above.

- [ ] **Step 1: Write failing tests**

```ts
test('repoName uses last segment', () =>
  assert.deepEqual(repoName('/Users/e/src/api-proxy'), { repo: 'api-proxy' }))
test('repoName unwraps worktrees', () =>
  assert.deepEqual(repoName('/Users/e/src/api-orders/.claude/worktrees/tkt-7730'),
    { repo: 'api-orders', worktree: 'tkt-7730' }))
test('transcriptPath replaces every non-alphanumeric', () =>
  assert.equal(transcriptPath('/p', '/Users/e/src/a_b/.claude/worktrees/x', 'S'),
    '/p/-Users-e-src-a-b--claude-worktrees-x/S.jsonl'))
```

- [ ] **Step 2: Run `npm test`; expect FAIL (module not found).**
- [ ] **Step 3: Implement.** `package.json`: `{"type":"module","scripts":{"test":"node --test 'tests/**/*.test.ts'"}}`. `bin/claude-tabs`: `#!/usr/bin/env node` importing `../src/cli.ts` via a resolved file URL (symlink-safe: resolve `realpathSync(process.argv[1])`). `realExec` wraps `spawnSync` with `encoding: 'utf8'`; a spawn error (ENOENT) returns `status: 127` and the message in `stderr`.
- [ ] **Step 4: Run `npm test`; expect PASS.**
- [ ] **Step 5: Commit** `feat: scaffold claude-tabs with path helpers`

### Task 2: Transcript digests

**Files:**
- Create: `src/transcript.ts`, `tests/fixtures/transcript-basic.jsonl`, `tests/fixtures/transcript-truncated.jsonl`
- Test: `tests/transcript.test.ts`

**Interfaces:**
- Consumes: `Digest`, `repoName`.
- Produces: `extractDigest(path: string, fallback: { sessionId: string, cwd?: string }, opts?: { tailBytes?: number }): Digest`

Fixture `transcript-basic.jsonl` contains, in order: a `user` entry whose content is `<command-name>/clear</command-name>`, a `user` entry "Is envoy exposing api-accounts?" with `cwd` and `gitBranch: "main"`, two `ai-title` entries ("Old", then "Envoy api-accounts exposure"), a `last-prompt` entry "check staging too", a later entry with `gitBranch: "tkt-1"`, and a long middle padding (>64 KB of `assistant` lines) so head and tail windows do not overlap.

- [ ] **Step 1: Write failing tests**

```ts
test('takes latest title, first real prompt, last prompt, latest branch', () => {
  const d = extractDigest(fixture('transcript-basic.jsonl'), { sessionId: 'S' }, { tailBytes: 4096 })
  assert.equal(d.title, 'Envoy api-accounts exposure')
  assert.equal(d.firstPrompt, 'Is envoy exposing api-accounts?')
  assert.equal(d.lastPrompt, 'check staging too')
  assert.equal(d.branch, 'tkt-1')
})
test('custom-title beats ai-title', ...)
test('half-written final line is skipped', () => {
  const d = extractDigest(fixture('transcript-truncated.jsonl'), { sessionId: 'S' })
  assert.equal(d.title, 'Envoy api-accounts exposure')
})
test('missing file returns fallback digest with note', () => {
  const d = extractDigest('/nope.jsonl', { sessionId: 'S', cwd: '/x/api-proxy' })
  assert.equal(d.repo, 'api-proxy'); assert.match(d.note!, /transcript/)
})
test('prompts trimmed to 200 chars', ...)
```

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Read the first 64 KB for `firstPrompt` and `cwd`; read the last `tailBytes` (default 256 KB), drop the first partial line, parse each line with try/catch. If the tail yields no title, double the window up to the whole file. `user` content may be a string or an array of `{type:'text',text}` blocks; skip text starting with `<command`, `<local-command`, `<system`. Title precedence `customTitle` > `aiTitle` > `summary`. `lastActive` = file mtime in ms. `cwd` from the transcript wins over the fallback.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: extract session digests from transcripts`

### Task 3: Digest cache

**Files:** Create `src/cache.ts`; Test `tests/cache.test.ts`

**Interfaces:**
- Consumes: `extractDigest`.
- Produces: `class DigestCache { static load(file: string, warn: (m: string) => void): DigestCache; get(path: string, extract: () => Digest): Digest; save(): void }` (plain class fields only, no parameter properties).

- [ ] **Step 1: Write failing tests:** a second `get` with unchanged size+mtime does not call `extract`; touching the file (new mtime) calls it again; a corrupt cache file loads empty and calls `warn` once with a message containing `rebuilding`; `save` writes atomically (temp file + rename) and creates the directory.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Key by absolute path; entry stores `{ size, mtimeMs, digest }`. A missing transcript bypasses the cache.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: cache digests by size and mtime`

### Task 4: Live sessions

**Files:** Create `src/live.ts`, `tests/fixtures/sessions/` (three `<pid>.json` files: one live CLI, one live with `entrypoint: "sdk-cli"`, one dead); Test `tests/live.test.ts`

**Interfaces:**
- Consumes: `Exec`, `DigestCache`, `extractDigest`, `transcriptPath`.
- Produces: `collectLiveSessions(opts: { sessionsDir: string, projectsDir: string, exec: Exec, cache: DigestCache }): Candidate[]`

- [ ] **Step 1: Write failing tests** with a fake `exec` answering `ps -axo pid=,tty=,comm=`:

```ts
test('keeps live cli sessions with tty', () => {
  const c = collectLiveSessions({ ...fixtures, exec: fakePs('5176 ttys022 claude') })
  assert.equal(c.length, 1)
  assert.equal(c[0].tty, '/dev/ttys022'); assert.equal(c[0].status, 'shell'); assert.equal(c[0].live, true)
})
test('ignores a pid reused by a non-claude process', () => {
  assert.equal(collectLiveSessions({ ...fixtures, exec: fakePs('5176 ttys022 zsh') }).length, 0)
})
test('ps failure throws', () =>
  assert.throws(() => collectLiveSessions({ ...fixtures, exec: failing }), /ps/))
```

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** One `ps` call for all pids; a pid counts as alive only when present and `comm` basename is `claude`. `tty` `??` means none. Unknown `status` maps to `'unknown'`. Digest via `cache.get(transcriptPath(...), ...)`; if that path does not exist, look for `<projectsDir>/*/<sessionId>.jsonl` before falling back.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: collect live sessions from pid files and ps`

### Task 5: Local scoring

**Files:** Create `src/score.ts`, `tests/fixtures/real-sessions.json` (digests built from the 21 live titles in the spec's verified facts, with repos and recency); Test `tests/score.test.ts`

**Interfaces:**
- Consumes: `Candidate`.
- Produces: `tokenize(query: string): string[]`, `rankLocal(query: string, cands: Candidate[]): Array<{ cand: Candidate, score: number }>` (score > 0 only, descending), `clearWinner(ranked): Candidate | undefined`.

- [ ] **Step 1: Write failing tests**

```ts
test('filler-only query tokenizes to nothing', () =>
  assert.deepEqual(tokenize('working on the session'), []))
test('envoy api-accounts resolves locally', () => {
  const w = clearWinner(rankLocal('envoy api-accounts', real))
  assert.equal(w?.digest.title, 'Envoy api-accounts exposure and staging')
})
test('working on envoy in api-proxy has a clear winner or none, never a wrong one', ...)
test('csv ingestion is ambiguous (three sessions)', () =>
  assert.equal(clearWinner(rankLocal('csv ingestion', real)), undefined))
test('TKT ticket ids match exactly', () =>
  assert.equal(clearWinner(rankLocal('TKT-7730', real))?.digest.title,
    'TKT-7730 domains name case-insensitive unique'))
test('recency breaks a tie', ...)
```

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Lowercase; split on non-alphanumerics except keep `[a-z]+-\d+` ticket ids whole; also split hyphenated words into parts. Field weights: title 3, repo/worktree 3, branch 2, lastPrompt 2, firstPrompt 1; exact word hit counts full weight, prefix/substring half. Recency boost at most 0.5 decaying over 7 days. `clearWinner`: top score >= 4 and >= 1.5x the runner-up (tune until the tests pass; record final values as named constants).
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: score sessions locally`

### Task 6: Haiku fallback

**Files:** Create `src/llm.ts`; Test `tests/llm.test.ts`

**Interfaces:**
- Consumes: `Exec`, `Candidate`.
- Produces: `buildHaikuArgs(query: string, cands: Candidate[]): { args: string[], input: string }`, `parseHaikuRanking(stdout: string, knownIds: Set<string>): Array<{ sessionId: string, summary: string }>` (throws on malformed), `askHaiku(query, cands, exec, warn): Array<{ sessionId: string, summary: string }> | undefined` (undefined = failed, caller uses local order).

- [ ] **Step 1: Write failing tests:** args include `-p`, `--model haiku`, `--no-session-persistence`, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--output-format json`, `--json-schema`, and `--system-prompt`; input holds at most 15 digests, each line `id | repo | branch | title | last prompt`; `parseHaikuRanking` drops unknown ids and throws on non-JSON; `askHaiku` with exec status 127 returns `undefined` and warns `claude not found, using local ranking`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** The schema is `{ matches: [{ sessionId, summary }] }`; read it from the `--output-format json` result's `structured_output` (fall back to parsing `result`). Short system prompt: rank sessions matching the user's description, omit non-matches, one-line summary each. Verify flag spellings with `claude --help` on the installed version.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Measure one real call:** `node -e` a call against the live list with `--output-format json` and record `usage.input_tokens` plus cache tokens for the README. If input exceeds ~5,000 tokens, find what is loading (tools, CLAUDE.md, MCP) and switch it off.
- [ ] **Step 6: Commit** `feat: haiku fallback ranking`

### Task 7: Adapter interface, detection, iTerm2

**Files:** Create `src/terminals/adapter.ts`, `src/terminals/iterm2.ts`, `tests/fixtures/iterm2-panes.json`; Test `tests/iterm2.test.ts`, `tests/adapter.test.ts`

**Interfaces:**
- Consumes: `Exec`.
- Produces:

```ts
export interface TerminalAdapter {
  name: 'iterm2' | 'wezterm'
  listPanes(): Pane[]
  focus(pane: Pane): void
  openPane(cwd: string, command: string): void
}
export function detectAdapter(env: Record<string, string | undefined>, exec: Exec, override?: string): TerminalAdapter | undefined
export function iterm2Adapter(exec: Exec): TerminalAdapter
```

- [ ] **Step 1: Write failing tests:** `listPanes` parses fixture JXA output into Panes with 1-based `windowIndex`/`tabIndex`; `focus` passes the session `unique id` to the JXA script as an argument (never interpolated into script text); an `osascript` failure containing `-1743` throws an error naming System Settings > Privacy & Security > Automation; `detectAdapter` picks iTerm2 from `TERM_PROGRAM=iTerm.app`, honors the override, falls back to iTerm2 when `TERM_PROGRAM=vscode` and `pgrep -x iTerm2` succeeds, and returns `undefined` when nothing is running.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** JXA scripts run via `osascript -l JavaScript -e <script> <args>` with `run(argv)`. List: iterate `Application('iTerm2').windows()` in order, tabs, sessions; return JSON. Focus: find session by `uniqueId`, `select()` session, tab and window, then `activate()`. Open: `createTabWithDefaultProfile` on the front window, then `write({ text: 'cd <quoted cwd> && <command>' })`.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Manual smoke:** `node -e` listing panes on the real machine shows all Claude tabs.
- [ ] **Step 6: Commit** `feat: iterm2 terminal adapter and detection`

### Task 8: WezTerm adapter

**Files:** Create `src/terminals/wezterm.ts`, `tests/fixtures/wezterm-list.json` (shape from WezTerm docs); Test `tests/wezterm.test.ts`

**Interfaces:**
- Consumes: `Exec`, `Pane`, `TerminalAdapter`.
- Produces: `weztermAdapter(exec: Exec): TerminalAdapter`; `detectAdapter` gains `TERM_PROGRAM=WezTerm` and the `wezterm cli list` fallback.

- [ ] **Step 1: Write failing tests:** fixture parses to Panes (`tty_name` to `tty`, window order by first appearance for `windowIndex`, tab order within window for `tabIndex`); `focus` runs `wezterm cli activate-pane --pane-id <id>`; `openPane` runs `wezterm cli spawn --cwd <cwd> -- sh -c <command>`.
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: wezterm terminal adapter`

### Task 9: Picker

**Files:** Create `src/picker.ts`; Test `tests/picker.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `Exec`.
- Produces: `formatPickerLine(c: Candidate, summary?: string, now?: number): string`, `parsePickerSelection(line: string): string` (session id), `pick(cands: Candidate[], summaries: Map<string, string>, exec: Exec, io: { hasFzf: boolean, prompt: (q: string) => string }): Candidate | undefined`.

- [ ] **Step 1: Write failing tests:** line is `<sessionId>\t<title> · <repo> · <branch> · <age> · <status>[ · dir gone]` with tabs, newlines and control chars in fields replaced by spaces; `parsePickerSelection` returns the id for a title containing `✳`, quotes and `·`; age formats as `5m`, `3h`, `2d`; numbered fallback returns the chosen candidate and `undefined` on empty input.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** fzf args: `--delimiter '\t' --with-nth 2.. --no-sort` (input already ranked), `--preview` printing the digest from a temp JSON file keyed by id. Exit status 130 (Esc) returns `undefined`.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: fzf picker with numbered fallback`

### Task 10: Closed sessions (`--all`)

**Files:** Create `src/history.ts`; Test `tests/history.test.ts`

**Interfaces:**
- Consumes: `DigestCache`, `extractDigest`.
- Produces: `listClosedSessions(opts: { projectsDir: string, liveIds: Set<string>, cache: DigestCache, dirExists: (p: string) => boolean }): Candidate[]`, `resumeCommand(config: { resumeCommand?: string }, sessionId: string): string`.

- [ ] **Step 1: Write failing tests:** live ids are excluded; a digest whose cwd does not exist gets `dirGone: true`; `resumeCommand({}, 'S')` is `claude --resume S`; `resumeCommand({ resumeCommand: 'claude --dangerously-skip-permissions --resume {id}' }, 'S')` substitutes `{id}`; a template without `{id}` throws.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Walk `projectsDir/*/*.jsonl` (top level only, skip subdirectories). Every digest goes through the cache.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: include closed sessions with --all`

### Task 11: CLI wiring, install, README

**Files:** Create `src/cli.ts`, `README.md`; Test `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `parseArgs(argv: string[]): Options`, `run(opts: Options, deps: Deps): number` (exit code), where `Deps` bundles `exec`, `env`, dirs, `stdout`, `stderr`, `prompt`, `now`.

- [ ] **Step 1: Write failing tests** with fake deps:
  - clear local winner with adapter: focuses that pane, prints `→ <title> · <repo> · tab N`, exits 0, never calls `claude`
  - two windows: line includes `window W`
  - `--list` with a clear winner: prints, never focuses
  - filler-only query: goes to picker with all live sessions
  - ambiguous query: calls Haiku; one id returned switches; several go to picker in Haiku order
  - `--no-llm` ambiguous: picker in local order, no `claude` call
  - no adapter: lists with tty, exit 0
  - no matches without `--all`: prints `No matching sessions. Try --all.`, exit 1
  - `--all` closed pick: `openPane(cwd, resumeCommand)`; `dir gone` pick prints the command and reason, exit 1
  - `--json`: valid JSON array, implies `--list`
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** `parseArgs` with `node:util` `parseArgs`, and `run` as the pipeline in the spec. `src/cli.ts` also has the entry block that builds real deps when run as main. Config read from `~/.config/claude-tabs/config.json`; missing file is `{}`, invalid JSON is an error.
- [ ] **Step 4: Run full `npm test`; expect PASS.**
- [ ] **Step 5: Install and smoke on the real machine:** `ln -s ~/ecoutu/src/claude-tabs/bin/claude-tabs ~/bin/claude-tabs && ln -s claude-tabs ~/bin/ct`; run `ct envoy api-accounts` (switches), `ct csv ingestion` (Haiku or picker), `ct --all --list envoy`.
- [ ] **Step 6: README:** install, usage, flags, config, the measured Haiku token figure from Task 6, and the manual smoke checks for iTerm2 and WezTerm.
- [ ] **Step 7: Commit** `feat: wire claude-tabs cli` and `docs: add README`
