# ct pause / ct resume: design

## Why

Restarting the machine with ~20 Claude Code sessions open is a manual ritual today, driven by
two scripts in Emma's home directory (`~/claude-sessions-snapshot.sh`, `~/resume-sessions.sh`):
paste a stop prompt into every tab, wait for each session to write a HANDOFF message, snapshot
the open sessions to Markdown, reboot, then reopen every session with a resume prompt.

`ct pause` and `ct resume` replace both scripts and the Markdown snapshot. `ct` already finds
live sessions, knows their tabs, and can open a resumed session in a new tab, so most of the
machinery exists.

## Goals

- `ct pause`: send the stop prompt to every live Claude session, watch until each one writes its
  HANDOFF, record every open session, and say when it is safe to restart.
- Stragglers are shown in a live list that refreshes itself; clicking (or Enter on) a row jumps to
  that session's tab while the list keeps running.
- `ct pause --auto-close`: close each session as soon as its HANDOFF is written.
- `ct resume`: after the restart, reopen every recorded session in its own tab, in the original
  window and tab order, with the resume prompt.
- Works in iTerm2 and WezTerm through the existing adapter interface.

## Non-goals

- Restarting or shutting down the machine.
- Running `ct resume` automatically at login (Emma runs it by hand).
- Reading or summarising HANDOFF contents; the resumed session reads its own.
- A readable snapshot file. The snapshot is machine data.

## Anti-goals

- Pressing keys for the user beyond typing the stop prompt and, with `--auto-close`, the exit
  command: never approve a permission prompt, never interrupt a busy session, never send Esc.
- Closing a session that has not written a HANDOFF, under any flag or timeout.
- Leaving a session out of the snapshot because it misbehaved.
- `ct resume` opening a second copy of a session that is already running.

## Constraints

Everything in the `claude-tabs` design applies: Node 24+, zero dependencies, `fzf` optional,
no code comments except JSDoc on exports, no em dashes, errors never read as empty results.

## Verified facts

Checked 2026-11-10 on the work machine:

| Fact | Source |
|------|--------|
| Session `status` is only `idle`, `busy` or `shell`, with `statusUpdatedAt` (ms). Nothing marks a pending permission prompt. | 17 live `~/.claude/sessions/*.json` |
| Each session file also has `messagingSocketPath` and `peerProtocol`; the protocol is undocumented | same |
| iTerm2 JXA sessions expose `write`, `close`, `isAtShellPrompt` | `osascript` probe |
| WezTerm: `wezterm cli send-text --pane-id N --no-paste <text>` types into a pane; `wezterm cli kill-pane --pane-id N` closes it | WezTerm docs; not installed at work, unverified |
| Today's prompts live in `~/.claude/session-restart/stop.txt` and `resume.txt`; the stop prompt asks for "a message headed HANDOFF" and to stop and wait | file contents |
| fzf supports mouse clicks by default, `--listen` for an HTTP control port, and `reload(...)` / `execute-silent(...)` actions | fzf docs |

## How

### Prompts and config

The two prompts become config with built-in defaults equal to today's `stop.txt` and
`resume.txt` text. `~/.config/claude-tabs/config.json` may override them:

```json
{
  "resumeCommand": "claude --dangerously-skip-permissions --resume {id}",
  "stopPrompt": "...",
  "resumePrompt": "...",
  "pauseTimeoutMinutes": 10
}
```

Emma's existing files are migrated once by hand (copy into config); `ct` does not read
`~/.claude/session-restart/`.

### Adapter additions

```ts
sendText(pane: Pane, text: string): void
closePane(pane: Pane): void
openPane(cwd: string, command: string, opts?: { newWindow?: boolean }): void
```

- iTerm2: `session.write({ text })` (submits with a newline); `session.close()`.
- WezTerm: `send-text --no-paste` with a trailing carriage return; `kill-pane`.
- `openPane` with `newWindow`: iTerm2 `createWindowWithDefaultProfile`, WezTerm `spawn --new-window`.
  `Pane` already carries `windowIndex` and `tabIndex`, which the snapshot records.
- Text is passed as an argument, never interpolated into script source (as today).

### `ct pause`

1. Collect live sessions and their panes. A session with no reachable pane is a straggler from
   the start ("can't reach: not in a supported terminal").
2. Write the snapshot immediately (step "Snapshot" below), before anything is typed, so a crash
   mid-pause still leaves a usable record.
3. Type the stop prompt into every reachable session whose status is `idle` or `busy`. A session
   with status `shell` is never typed into: its input may be in shell mode, where the text would
   run as a shell command. It is a straggler from the start (`in shell mode`), and the user can
   send the prompt with the row action once it is back to normal input. A busy session receives it as queued
   input, which is how Claude Code handles typing while busy; nothing is interrupted.
4. Watch every session until done or the timeout. A session is **done** when its status is
   `idle` and its latest assistant message, written after the stop prompt was sent, contains a
   line starting with `HANDOFF`. Otherwise it is in one of these states, shown with how long it
   has been in it:
   - `busy`: status busy and the transcript grew in the last 2 minutes
   - `may need you`: status busy and the transcript has not grown for 2 minutes (the likeliest
     sign of a permission prompt; unverifiable, so the label says "may")
   - `idle, no HANDOFF`: idle but the latest assistant message has no HANDOFF
   - `in shell mode`: status `shell`; never typed into
   - `can't reach`: no pane
   - `exited`: the pid is no longer a live `claude` process (same check as session discovery)
     and no HANDOFF was written. A session `ct` exited through `--auto-close` is `closed`, not
     `exited`.
5. With `--auto-close`, a session is closed the moment it is done: type `/exit`, wait up to 10 s
   for the process to end, then close the pane. If the process does not end, leave the pane open
   and mark it `exit failed`.
6. Straggler list (below) runs until every session is done or exited, the timeout passes, or the
   user quits it. Then print a summary: done count, closed count, and each straggler with its
   state, ending with `Safe to restart.` when none remain, otherwise
   `N sessions have no HANDOFF; they are still recorded.` Every session resumes with the same
   resume prompt, which already covers a missing HANDOFF ("If there is no HANDOFF message,
   summarize where we left off and ask").

Re-sending the stop prompt is not automatic. A row action (below) re-sends it on request.

### Straggler list

With fzf and a TTY: one fzf instance with `--listen` on a random localhost port, input from
`ct _stragglers <snapshotId>` (hidden subcommand printing current straggler lines). A background
loop in `ct pause` posts `reload(ct _stragglers <snapshotId>)` every 3 s and the auto-close work
runs in that same loop. Bindings:

- Enter or click: `execute-silent(ct _focus {1})` jumps to the session's tab; the list stays open.
- `ctrl-r`: `execute-silent(ct _send-stop {1})` re-sends the stop prompt to that session.
- Esc: leave the list; `ct pause` prints the summary and exits.
- The list closes itself when empty.

Line format reuses the picker's: id, tab, then title · repo · state · duration · tab N.

Without fzf or without a TTY: a plain list redrawn every 3 s with the same lines, numbered; typing
a number and Enter jumps to that session.

The hidden subcommands are internal and undocumented; their output format carries no promise.

### Snapshot

JSON at `~/.local/state/claude-tabs/snapshots/<ISO timestamp>.json`, owner-only (dir 0700, file
0600, same write path as the digest cache). Contents per session: `sessionId`, `cwd`, `title`,
`repo`, `branch`, `windowIndex`, `tabIndex`, `terminal`, `handoffWritten` (boolean, used only in
summaries), plus a pause-level `createdAt`. The
snapshot is updated in place as sessions finish so it records which ones wrote a HANDOFF.
Snapshots older than 30 days are deleted at the next `ct pause`.

### `ct resume`

```
ct resume [--dry-run] [--no-prompt] [--snapshot <path>]
```

- Reads the newest snapshot (or `--snapshot`).
- Skips sessions that are already live (matched by `sessionId`), and sessions whose directory no
  longer exists (listed in the output with the command, as `ct --all` does today).
- Opens the rest in window and tab order: one window per recorded `windowIndex`, tabs in
  `tabIndex` order. The first tab of each recorded window opens a new window; the rest open as
  tabs in it.
- Each tab runs `cd <cwd> && <resumeCommand> <quoted resumePrompt>` unless `--no-prompt`.
- `--dry-run` prints the commands only.
- Prints a one-line result per session and a count.
- Running it twice opens nothing the second time (already live).

### Retiring the scripts

Once `ct pause` and `ct resume` ship, `~/claude-sessions-snapshot.sh` and `~/resume-sessions.sh`
are deleted by Emma after one successful restart cycle. `ct` does not delete them.

### Testing

`node --test` with fakes, as today: done/straggler state classification from fixture transcripts
and status files (including a HANDOFF written before the stop prompt, which must not count);
auto-close never closing a non-done session; snapshot write/update/prune; resume ordering,
skip-live, skip-dir-gone, dry-run; adapter `sendText`/`closePane` argument passing. Manual checks
in the README for the live fzf list and a real restart cycle.

## Left to the builder

- Module layout, poll interval tuning, exact fzf flags and line layout.
- How `ct pause` waits for `/exit` to end the process.
- Whether the background loop is a timer in the `ct pause` process or a child process.

## Calls made without Emma's input

- Snapshot is written before the stop prompt is typed, and updated as sessions finish.
- "may need you" is inferred from 2 minutes of busy with no transcript growth.
- Re-sending the stop prompt is a manual row action, not automatic.
- Default timeout 10 minutes, poll every 3 s, snapshots pruned after 30 days.
- Prompts move into `ct` config with today's text as defaults.
- `ct resume` recreates windows (new `openPane` option on both adapters).
- Sessions with status `shell` are never typed into.
- One resume prompt for every session, with or without a HANDOFF.
- `exited` means the pid is no longer a live `claude` process.
- `/exit` is how `--auto-close` ends a session before closing its pane.
