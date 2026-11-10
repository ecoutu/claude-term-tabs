# claude-tabs: design

## Why

Emma runs 2-3 dozen terminal tabs at once, most of them Claude Code sessions. Finding one by eye
is slow. What she remembers about a session is the repo, the gist of what she asked, and roughly
how recently she touched it. `claude-tabs` takes that memory as a loose phrase and gets her to the
tab:

```bash
ct "working on envoy in api-proxy"
```

It runs on iTerm2 at work and WezTerm on personal machines, so terminal support sits behind a
small adapter interface.

## Goals

- Find live Claude Code sessions from a natural-language phrase and say which tab each is in.
- One clear match: switch to its tab. Several plausible matches: a picker with repo, one-line
  summary and last-active time; choosing one switches to it.
- Spend no tokens when local matching is enough. When it is not, spend as few as possible.
- `--all` also searches closed sessions; choosing one resumes it in a new tab.
- Terminal-agnostic core with iTerm2 and WezTerm adapters.

## Non-goals

- Managing sessions: no killing, renaming, or restarting.
- tmux panes, Linux terminals, Terminal.app (the adapter interface leaves room; none ship now).
- A background daemon or file watcher.
- Searching full assistant replies or tool output.

## Anti-goals

Any of these makes it a failure even if it technically works:

- Silently switching to the wrong tab on a weak match.
- Calling Claude for a query local matching could have answered.
- Feeling slow: the live-session path without a Claude call should return in well under a second.
- Its own Claude calls showing up as sessions in later `--all` searches.

## Constraints

- macOS, Node 26 (native TypeScript, no build step). No npm dependencies.
- `fzf` is installed on the work machine; the picker uses it when present.
- `claude` CLI is on PATH and authenticated; it is the only route to a model.
- Personal repo `ecoutu/claude-tabs`, private.

## Verified facts the design rests on

Checked on the work machine on 2026-11-10 (Claude Code 2.1.319, iTerm2, 21 live sessions):

| Fact | Source |
|------|--------|
| Every running session writes `~/.claude/sessions/<pid>.json` with `sessionId`, `cwd`, `name`, `status` (`idle`/`busy`/`shell`), `updatedAt` (ms), `entrypoint` (`cli` for interactive), `kind` | file contents |
| A resumed session's file holds the resumed `sessionId`, not a new one | pid 15369 vs its `--resume` arg |
| `ps -o pid,tty` gives each `claude` process its terminal device | `ps -axo pid,tty,command` |
| iTerm2 AppleScript lists, per window/tab/session: `tty`, `unique id`, `name`; tab order is the iteration order | `osascript` loop; all 21 Claude tabs matched a tty |
| Transcript path is `~/.claude/projects/<cwd with every non-alphanumeric char replaced by ->/<sessionId>.jsonl` | Emma's existing `~/claude-sessions-snapshot.sh` |
| Transcripts are JSONL; useful entry types: `ai-title` (`aiTitle`), `custom-title` (`customTitle`), `summary`, `last-prompt`, `user` (`message.content`), and `gitBranch` on most entries. Titles repeat; the last one wins | `jq` over a live transcript |
| iTerm2 tab names already show the `ai-title` | AppleScript `name of s` |
| 1,626 transcripts, 3.2 GB under `~/.claude/projects` | `ls`, `du` |
| WezTerm: `wezterm cli list --format json` returns panes with `pane_id`, `tab_id`, `window_id`, `tty_name`, `cwd`, `title`; `wezterm cli activate-pane --pane-id N` focuses one; `wezterm cli spawn --cwd DIR -- cmd` opens one | WezTerm docs; not installed at work, so unverified here |

## How

### Shape

A single CLI, `claude-tabs`, installed with a `ct` alias (symlink into `~/bin`). TypeScript run
directly by Node, structured as pure modules plus a thin CLI entry, so the logic is testable with
`node --test`.

```
ct [query] [--list] [--all] [--json] [--no-llm] [--terminal iterm2|wezterm]
```

- No query: picker over all live sessions, most recent first.
- `--list`: print matches, never switch.
- `--all`: include closed sessions.
- `--json`: machine-readable output (implies `--list`). For debugging and ad-hoc scripting; no
  stability promise.
- `--no-llm`: local matching only.
- `--terminal`: override adapter detection.

### Pipeline

1. **Collect live sessions.** Read `~/.claude/sessions/*.json`. Keep entries whose pid is alive
   and whose `entrypoint` is `cli`. Get each pid's tty from `ps`.
2. **Attach tabs.** Ask the terminal adapter for its panes and join on tty. A session with no
   matching pane (other terminal, no adapter) is still listed, with its tty and no "switch".
3. **Build digests.** For each session, from its transcript: latest title (`custom-title` beats
   `ai-title` beats `summary`), latest `last-prompt`, first real user prompt (skip
   `<command…>`/`<local-command…>`/`<system…>` wrappers, as the snapshot script does), latest
   `gitBranch`. Plus `cwd`, a repo name derived from it, `status`, last-active time. Prompts
   trimmed to ~200 chars.
4. **Match locally** (below). Clear winner: done.
5. **Ask Haiku** only when local matching is ambiguous (below).
6. **Act**: switch, print, or picker.

### Reading transcripts cheaply

Transcripts can be large. Read the head for the first prompt and the tail (a bounded window,
growing if no title is found) for the latest title, last prompt and branch. Never parse whole
files on the live path unless the tail window fails to yield a title.

Cache digests in `~/.cache/claude-tabs/digests.json`, keyed by transcript path with its size and
mtime; reuse an entry when both match. `--all` uses the same cache, so the first `--all` run
indexes every transcript once and later runs only re-read changed ones. The cache is disposable:
a corrupt or unreadable cache is discarded and rebuilt, with a warning on stderr.

A transcript that is missing or unparseable yields a digest with what the sessions file had
(cwd, name, status) and a note in `--list` output; it never drops the session.

### Repo name

The last path segment of `cwd`, except inside a worktree (`…/<repo>/.claude/worktrees/<slug>`),
where it is `<repo>` and the slug is kept as an extra searchable field.

### Local matching

Tokenize the query, drop filler words ("working", "on", "in", "the", "session", …). Score each
digest by weighted token hits: title and repo high, branch and last prompt medium, first prompt
low; prefix and substring hits count, with exact-word hits counting more. A small recency boost
breaks near-ties, ranking by last-active time, not tab order.

A clear winner (top score above a floor and well ahead of the runner-up) switches without a
model call. The exact weights and thresholds are the builder's to tune against fixtures built
from the real session list above; "envoy api-accounts" must resolve locally to the "Envoy
api-accounts exposure and staging" session.

### Haiku fallback

When no clear winner exists, send the top candidates (at most 15) as compact digests to Haiku and
ask for a ranked list of matching session ids, each with a one-line summary, as JSON.

Keeping it cheap:

- `claude -p --model haiku` with the Claude Code system prompt replaced by a short purpose-built
  one, all tools and MCP servers disabled, settings sources off, and
  `--no-session-persistence` so the call never becomes a transcript.
- The builder measures the actual input tokens of one call and records the figure in the README;
  the target is a few thousand tokens for 15 digests.
- Model output is validated (known ids only). A failed or malformed call falls back to the local
  ranking with a stderr warning; it never reads as "no matches".

### Acting on results

- **One confident match**: switch to it and print one line (`→ <title> · <repo> · tab N`, with
  `window W` added when more than one window is open; both counted from 1 in on-screen order).
  `--list` prints instead of switching. Only local matching can produce a confident match. A
  Haiku result always goes to the picker, pre-sorted by Haiku's ranking, unless Haiku returns
  exactly one id, which switches.
- **Several**: `fzf` picker, one line per session (title, repo, branch, last active, status),
  with a preview pane showing the digest. Enter switches. Without `fzf`, a numbered list and a
  prompt.
- **None**: say so, and suggest `--all` if it was not set.
- **Closed session chosen (`--all`)**: open a new tab in its `cwd` running the resume command.
  Default `claude --resume <id>`; overridable in `~/.config/claude-tabs/config.json`
  (`resumeCommand`, with `{id}` placeholder), since Emma runs with
  `--dangerously-skip-permissions`. Take `cwd` from the transcript's own entries (the project
  directory name cannot be decoded back to a path). When that directory no longer exists (a
  deleted worktree, usually), still list the session, marked `dir gone`; choosing it prints the
  resume command and why it cannot open it, rather than resuming from a different directory,
  since `claude --resume` looks up the transcript by the directory it runs in.

### Terminal adapters

```ts
interface TerminalAdapter {
  name: string
  detect(env: NodeJS.ProcessEnv): boolean
  listPanes(): Promise<Pane[]>
  focus(pane: Pane): Promise<void>
  openPane(cwd: string, command: string): Promise<void>
}

interface Pane {
  id: string
  tty: string
  title: string
  windowId: string
  tabIndex: number
}
```

- Detection from `TERM_PROGRAM` (`iTerm.app`, `WezTerm`); `--terminal` overrides. Run from
  anywhere else (a VS Code terminal, say), it falls back to whichever supported terminal is
  running (iTerm2 app running, or `wezterm cli list` succeeding); with none, it lists matches
  without switching.
- `Pane` also carries `windowIndex` (on-screen order, from 1) for the confirmation line.
- **iTerm2**: `osascript` (JXA so the result comes back as JSON). Focus selects the session, its
  tab and its window, then activates iTerm2. Open creates a tab in the front window and writes
  the command to it.
- **WezTerm**: `wezterm cli list --format json`, `activate-pane`, `spawn`. Written against the
  docs and fixtures; verified by Emma on a personal machine.
- Adapter failures (app not running, AppleScript permission denied) are reported as errors with
  the fix, never as "no panes".

### Testing

`node --test` over: transcript digest extraction (fixture JSONL with every entry type above,
including wrappers and repeated titles), repo naming, local scoring and the clear-winner rule,
Haiku output validation, cache reuse/invalidation, and the pipeline with fake adapters. One
manual smoke check per real adapter, listed in the README.

## Left to the builder

- Module layout, scoring weights and thresholds, filler word list, tail window size.
- Exact `claude -p` flags that minimize tokens (verify against `claude --help` for the installed
  version).
- fzf line layout and preview formatting.
- README contents beyond the token measurement and smoke checks.

## Calls made without Emma's input

- TypeScript on Node with zero dependencies; JXA over the iTerm2 Python API.
- `ct` alias; private repo; `~/.cache` and `~/.config` locations.
- Recency breaks ties by last-active time, not tab position.
- Local matching first, Haiku only on ambiguity, top 15 candidates.
- No-query mode opens the picker over all live sessions.
- Resume command configurable, defaulting to plain `claude --resume`.
- Haiku results go to the picker unless Haiku returns exactly one id.
- Outside a supported terminal: fall back to a running one, else list only.
- `--json` carries no stability promise.
- Closed sessions whose directory is gone are listed, but not resumed.
- Tab and window numbers counted from 1 in on-screen order.
