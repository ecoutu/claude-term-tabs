# ct pause / ct resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ct pause` gets every live Claude session to write a HANDOFF and records them; `ct resume` reopens them after a restart.

**Architecture:** Pure modules for config, pause-state classification, snapshots and resume planning; one orchestrator that advances an immutable `PauseRun` on each tick; a thin UI layer (fzf with `--listen`, or a redrawn plain list) that drives ticks every 3 s. Adapters gain `sendText`, `closePane` and a `newWindow` option.

**Tech Stack:** Node 24+ native TypeScript, `node:test`, no npm dependencies, fzf 0.36+ (`--listen`) optional.

**Spec:** `docs/superpowers/specs/2026-11-10-pause-resume-design.md` (extends `docs/superpowers/specs/2026-11-10-claude-tabs-design.md`)

## Global Constraints

- Everything in the first plan's Global Constraints still holds (no deps, no comments except JSDoc on exports, no em dashes, errors never read as empty, conventional commits with no trailers).
- Stop prompt and resume prompt defaults are byte-for-byte today's `~/.claude/session-restart/stop.txt` and `resume.txt`.
- Never type into a session whose status is `shell`; never close a session that is not `done`.
- Poll every 3 s; "may need you" after 120 s busy with no transcript growth; default timeout 10 minutes; `/exit` gets 10 s before `exit failed`; snapshots older than 30 days are pruned.
- Snapshots: `~/.local/state/claude-tabs/snapshots/<id>.json`, dir 0700, file 0600, atomic write.
- Subcommands are recognised only as the first argument: `pause`, `resume`, `_focus`, `_send-stop`. Anything else is a search query as today.

## Review Focus

1. A session that wrote a HANDOFF earlier in its life (a previous restart) must not count as done; only an assistant message timestamped after this pause started counts.
2. A session the user closes by hand mid-pause becomes `exited` (or `done` if its HANDOFF landed first) and the list keeps running.
3. fzf being killed or exiting early must stop the background loop; the process must not hang.
4. `ct resume` run twice opens nothing the second time.
5. A resume prompt containing quotes, `$` or newlines reaches Claude intact through the shell command typed into the new tab.

---

## File Structure

```
src/fsutil.ts           writeOwnerOnly (atomic, 0600 file / 0700 dir); cache.ts switches to it
src/config.ts           loadConfig + defaults (moved out of cli.ts)
src/handoff.ts          latestAssistantText, hasHandoff
src/snapshot.ts         Snapshot types, saveSnapshot, latestSnapshot, pruneSnapshots
src/resume.ts           planResume, runResume
src/pause/state.ts      PauseState, classify
src/pause/run.ts        startPause, tickPause, resendStop, stragglerLines, pauseSummary
src/pause/ui.ts         runStragglerUi (fzf --listen, plain fallback)
src/terminals/*.ts      sendText, closePane, openPane newWindow
src/live.ts             Candidate gains pid
src/cli.ts              subcommand routing
```

---

### Task 1: Shared owner-only writes and config

**Files:** Create `src/fsutil.ts`, `src/config.ts`; Modify `src/cache.ts` (use `writeOwnerOnly`), `src/cli.ts` (import `loadConfig`); Test `tests/config.test.ts`, `tests/fsutil.test.ts`

**Interfaces:**
- Produces: `writeOwnerOnly(file: string, text: string): void`; `interface Config { resumeCommand?: string, stopPrompt: string, resumePrompt: string, pauseTimeoutMinutes: number }`; `loadConfig(path: string): Config`; `DEFAULT_STOP_PROMPT`, `DEFAULT_RESUME_PROMPT`.

- [ ] **Step 1: Write failing tests:** missing file gives defaults equal to the two prompt files' current text (copy into fixtures `tests/fixtures/stop.txt`, `resume.txt` and compare); overrides for each key are honoured; `pauseTimeoutMinutes` must be a positive number, `stopPrompt`/`resumePrompt` non-empty strings, else throws naming the key; invalid JSON throws naming the path; `writeOwnerOnly` creates the dir 0700, tightens an existing 0755 dir, writes the file 0600, leaves no temp file.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Move the cache's atomic write into `writeOwnerOnly`; cache and existing tests stay green.
- [ ] **Step 4: Run `npm test`; expect all PASS.**
- [ ] **Step 5: Commit** `refactor: share owner-only writes and move config into its own module`

### Task 2: Adapter additions

**Files:** Modify `src/terminals/adapter.ts`, `iterm2.ts`, `wezterm.ts`; Test `tests/iterm2.test.ts`, `tests/wezterm.test.ts`

**Interfaces:**
- Produces on `TerminalAdapter`: `sendText(pane: Pane, text: string): void`, `closePane(pane: Pane): void`, `openPane(cwd: string, command: string, opts?: { newWindow?: boolean }): void`.

- [ ] **Step 1: Write failing tests:** iTerm2 `sendText` and `closePane` pass the session id and text as osascript arguments (text with quotes and newlines appears verbatim as the last argument); `openPane` with `newWindow` passes a `new-window` flag argument; WezTerm `sendText` runs `cli send-text --pane-id N --no-paste <text>\r`, `closePane` runs `cli kill-pane --pane-id N`, `openPane` with `newWindow` adds `--new-window` after `spawn`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** iTerm2: SEND script finds the session by `id()` and calls `write({ text })`; CLOSE script calls `close()`; OPEN script uses `app.createWindowWithDefaultProfile()` and its `currentSession()` when `argv[2] === 'new-window'`.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Manual smoke:** `sendText` into this session's own tab is not safe to automate; instead open a scratch tab with `openPane('/tmp', 'echo hi', { newWindow: true })`, then `sendText` `echo there` into it and `closePane` it.
- [ ] **Step 6: Commit** `feat: adapters can type into, close and open windows for panes`

### Task 3: HANDOFF detection

**Files:** Create `src/handoff.ts`, fixture `tests/fixtures/transcript-handoff.jsonl`; Test `tests/handoff.test.ts`

**Interfaces:**
- Produces: `latestAssistantText(path: string, sinceMs: number): string | undefined` (text of the newest assistant entry with a `text` block and `timestamp >= sinceMs`); `hasHandoff(text: string | undefined): boolean`.

Fixture: an assistant HANDOFF at `2026-11-09T10:00:00Z`, a user message, then an assistant text "working on it" at `2026-11-10T10:00:00Z`, then a `tool_use`-only assistant entry at `2026-11-10T10:01:00Z`.

- [ ] **Step 1: Write failing tests:** since `2026-11-10T09:00Z` returns "working on it" (tool-only entry skipped); since `2026-11-11` returns undefined; the old HANDOFF is not returned for a since after it; `hasHandoff` is true for `HANDOFF`, `## HANDOFF`, `**HANDOFF**` at a line start, false for "write a HANDOFF later" mid-line and for undefined.
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement** reading the tail window like `extractDigest` (grow until an assistant text entry older than `sinceMs` or the file start is reached). **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: detect HANDOFF messages written after a point in time`

### Task 4: Pause state classification

**Files:** Create `src/pause/state.ts`; Modify `src/live.ts` and `src/types.ts` (`Candidate.pid?: number`, set by `collectLiveSessions`); Test `tests/pause-state.test.ts`, `tests/live.test.ts`

**Interfaces:**
- Produces:

```ts
export type PauseState = 'done' | 'closing' | 'closed' | 'exit-failed' | 'busy' | 'may-need-you' | 'idle-no-handoff' | 'in-shell-mode' | 'cant-reach' | 'exited'
export interface ClassifyInput { alive: boolean, status: Status, hasPane: boolean, handoff: boolean, msSinceGrowth: number }
export function classify(i: ClassifyInput): PauseState
export const STRAGGLER_STATES: ReadonlySet<PauseState>
export const MAY_NEED_YOU_AFTER_MS = 120_000
```

- [ ] **Step 1: Write failing tests**, one per row: handoff and idle → done; handoff and not alive → done; not alive, no handoff → exited; no pane → cant-reach; status shell → in-shell-mode; busy with growth 30 s ago → busy; busy with growth 121 s ago → may-need-you; idle without handoff → idle-no-handoff; handoff while busy → busy (not done until idle). `STRAGGLER_STATES` excludes done, closing, closed. `collectLiveSessions` sets `pid`.
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** `closing`, `closed`, `exit-failed` are set by the run (Task 6), never by `classify`. **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: classify sessions during a pause`

### Task 5: Snapshots

**Files:** Create `src/snapshot.ts`; Test `tests/snapshot.test.ts`

**Interfaces:**
- Consumes: `writeOwnerOnly`.
- Produces:

```ts
export interface SnapshotSession { sessionId: string, cwd: string, title?: string, repo: string, branch?: string, windowIndex?: number, tabIndex?: number, terminal?: 'iterm2' | 'wezterm', handoffWritten: boolean }
export interface Snapshot { id: string, createdAt: string, sessions: SnapshotSession[] }
export function snapshotFrom(cands: Candidate[], terminal: TerminalAdapter['name'] | undefined, now: number): Snapshot
export function saveSnapshot(dir: string, snap: Snapshot): string
export function latestSnapshot(dir: string): Snapshot | undefined
export function pruneSnapshots(dir: string, now: number, maxAgeMs: number): string[]
```

- [ ] **Step 1: Write failing tests:** `id` is the ISO timestamp with `:` replaced by `-`; save then latest round-trips; latest picks the newest of three by `createdAt`; a missing dir gives undefined; a corrupt newest file throws naming it (never silently falls back to an older snapshot); prune removes only files older than 30 days and returns their paths; files are 0600.
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: store pause snapshots`

### Task 6: Pause run

**Files:** Create `src/pause/run.ts`; Test `tests/pause-run.test.ts`

**Interfaces:**
- Consumes: `classify`, `hasHandoff`, `latestAssistantText`, `snapshotFrom`, `saveSnapshot`, `formatAge`, adapter `sendText`/`closePane`.
- Produces:

```ts
export interface Tracked { cand: Candidate, state: PauseState, since: number, lastSize: number, lastGrowth: number, closeRequestedAt?: number }
export interface PauseRun { startedAt: number, snapshot: Snapshot, tracked: Tracked[], autoClose: boolean }
export interface PauseDeps {
  now: () => number
  adapter?: TerminalAdapter
  collect: () => Candidate[]
  isAlive: (pid: number) => boolean
  transcriptOf: (c: Candidate) => string
  sizeOf: (path: string) => number
  snapshotDir: string
  config: Config
  warn: (m: string) => void
}
export function startPause(deps: PauseDeps, opts: { autoClose: boolean }): PauseRun
export function tickPause(run: PauseRun, deps: PauseDeps): PauseRun
export function resendStop(run: PauseRun, deps: PauseDeps, sessionId: string): void
export function stragglerLines(run: PauseRun, now: number): string[]
export function pauseSummary(run: PauseRun): { text: string, exitCode: number }
```

- [ ] **Step 1: Write failing tests** with a fake adapter recording calls and a fake clock:
  - start saves the snapshot before any `sendText` call (assert call order through a shared log)
  - start types `config.stopPrompt` into idle and busy sessions, never into `shell` ones or ones without a pane
  - a session whose transcript gains a HANDOFF after `startedAt` and goes idle becomes `done`; one with only an older HANDOFF stays `idle-no-handoff`
  - with `autoClose`, a done session gets `sendText('/exit')` once, becomes `closing`, then `closed` with `closePane` called once the pid is dead; still alive after 10 s becomes `exit-failed` and `closePane` is never called
  - without `autoClose`, nothing is ever closed
  - a non-done session is never sent `/exit` or closed, whatever the clock says
  - a session that disappears from `collect` with no HANDOFF becomes `exited`
  - the snapshot is re-saved with `handoffWritten` when a session becomes done
  - `stragglerLines` lists only straggler states, as `<sessionId>\t<title> · <repo> · <state label> · <duration> · tab N`, with labels `busy`, `may need you`, `idle, no HANDOFF`, `in shell mode`, `can't reach`, `exited`, `exit failed`
  - `pauseSummary` ends with `Safe to restart.` and exit 0 when no stragglers remain, else lists them, says `N sessions have no HANDOFF; they are still recorded.` and exits 1
  - `resendStop` types the stop prompt into that session only, and refuses (warns) for a `shell` session
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement** with each tick returning a new `PauseRun`; `startPause` also calls `pruneSnapshots`. **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: run a pause across live sessions`

### Task 7: Straggler UI

**Files:** Create `src/pause/ui.ts`; Test `tests/pause-ui.test.ts`

**Interfaces:**
- Consumes: `tickPause`, `stragglerLines`, `PauseRun`, `PauseDeps`.
- Produces: `fzfArgs(port: number, linesFile: string, self: string[]): string[]`; `runStragglerUi(run: PauseRun, deps: PauseDeps, io: { hasFzf: boolean, isTty: boolean, timeoutMs: number, self: string[], write: (s: string) => void }): Promise<PauseRun>` where `self` is the argv prefix that re-invokes `ct` (`[process.execPath, binPath]`).

- [ ] **Step 1: Write failing tests:** `fzfArgs` includes `--listen 127.0.0.1:<port>`, `--delimiter \t --with-nth 2..`, `--bind enter:execute-silent(<self> _focus {1})`, `--bind ctrl-r:execute-silent(<self> _send-stop {1})`, and a `start:reload(cat <linesFile>)` bind, with `self` and `linesFile` shell-quoted; the plain fallback (no fzf) driven by an injected clock writes a redrawn numbered list after each tick and returns when no stragglers remain; the timeout ends the loop and returns the latest run.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** fzf path: pick a free port (`net` listen on 0, read, close), write lines to a temp file (0600), `spawn('fzf', args, { stdio: ['ignore', 'ignore', 'inherit'] })`, `setInterval` every 3 s: `tickPause`, rewrite the file, `fetch('http://127.0.0.1:<port>', { method: 'POST', body: 'reload(cat <file>)' })`; when no stragglers remain or the timeout passes, POST `abort`. On fzf exit (any code, including being killed) clear the interval and resolve. A failed POST is a stderr warning, not a crash. Plain path: same interval, redraw with `\x1b[2J\x1b[H` when a TTY, else print only changed lines.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: live straggler list with click to jump`

### Task 8: Resume

**Files:** Create `src/resume.ts`; Test `tests/resume.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `resumeCommand`, `isResumableDir`, adapter `openPane`.
- Produces:

```ts
export interface ResumeStep { session: SnapshotSession, action: 'open' | 'skip-live' | 'skip-dir-gone', command: string, newWindow: boolean }
export function planResume(snap: Snapshot, liveIds: Set<string>, dirExists: (p: string) => boolean, config: Config, opts: { noPrompt: boolean }): ResumeStep[]
export function runResume(steps: ResumeStep[], adapter: TerminalAdapter | undefined, opts: { dryRun: boolean }, write: (s: string) => void): number
```

- [ ] **Step 1: Write failing tests:** steps sorted by `windowIndex` then `tabIndex` (missing values last, stable); `newWindow` true for the first `open` step of each window group only; live ids skipped; missing dirs skipped with the command still shown; command is `<resumeCommand> '<prompt>'` with the prompt single-quote-escaped so quotes, `$` and newlines survive (assert by running the command string through `sh -c 'printf %s "$1"'`-style decoding in the test); `--no-prompt` omits it; dry run calls no adapter method; no adapter prints the commands and returns 1; second plan over a world where all are live opens nothing.
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat: resume sessions from the latest snapshot`

### Task 9: CLI routing, docs, smoke

**Files:** Modify `src/cli.ts`, `README.md`; Test `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `main(argv)` routes `pause [--auto-close] [--timeout <min>]`, `resume [--dry-run] [--no-prompt] [--snapshot <path>]`, `_focus <id>`, `_send-stop <id>`; everything else is the existing search.

- [ ] **Step 1: Write failing tests:** `ct pause` with a fake world sends prompts, and the summary exit code reaches `main`; `ct resume --dry-run` prints commands from a fixture snapshot; `_focus <id>` focuses that pane; `_send-stop` on a shell-mode session exits 1 with a warning; `ct pause` as a search query is impossible but `ct -- pause` still searches for "pause"; unknown flags on each subcommand are usage errors.
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** **Step 4: Run full `npm test`; expect PASS.**
- [ ] **Step 5: README:** "Pause and resume" section (commands, flags, config keys with defaults, what each straggler state means, that it never presses keys beyond the stop prompt and `/exit`), and manual checks: (1) `ct resume --dry-run` after a `ct pause` lists every session in tab order; (2) a real `ct pause` on two scratch sessions shows them leaving the list; (3) one full restart cycle.
- [ ] **Step 6: Commit** `feat: ct pause and ct resume` and `docs: document pause and resume`
