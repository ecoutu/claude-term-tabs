# claude-tabs

Find a running Claude Code session by what you remember about it, and switch to its terminal tab.

```bash
ct working on envoy in api-proxy
# → Envoy api-accounts exposure and staging · api-proxy · tab 4
```

Works with iTerm2 and WezTerm on macOS.

## Install

Needs Node 24 or later. `fzf` is optional; without it the picker is a numbered list.

```bash
git clone https://github.com/ecoutu/claude-tabs ~/ecoutu/src/claude-tabs
ln -s ~/ecoutu/src/claude-tabs/bin/claude-tabs ~/bin/claude-tabs
ln -s claude-tabs ~/bin/ct
```

The first switch in iTerm2 asks macOS for permission to control iTerm2. Allow it, or grant it
later in System Settings > Privacy & Security > Automation.

## Usage

```
ct [query...] [--list] [--all] [--json] [--no-llm] [--terminal iterm2|wezterm]
```

| Situation | What happens |
|-----------|--------------|
| One clear local match | Switches to its tab |
| Several plausible matches | Asks Haiku to rank them, then shows a picker (or switches if Haiku picks exactly one) |
| No query | Picker over every live session, most recent first |
| `--list` | Prints matches, never switches |
| `--all` | Also searches closed sessions; choosing one resumes it in a new tab |
| `--json` | Machine-readable output, for debugging; no format promise |
| `--no-llm` | Local matching only |
| Not in iTerm2 or WezTerm | Uses whichever one is running, else lists without switching |

The search looks at each session's title, repo, worktree, branch and your first and last prompt.

## Config

`~/.config/claude-tabs/config.json`, optional:

```json
{ "resumeCommand": "claude --dangerously-skip-permissions --resume {id}" }
```

## Cost and speed

Measured on 2026-11-10 with 19 live sessions:

| Path | Time | Tokens |
|------|------|--------|
| Local match | ~0.65 s | none |
| Haiku fallback (15 sessions sent) | ~4 s | ~2,300 input, ~250 output (about $0.0006) |
| `--all` first run (1,626 transcripts indexed) | ~4 s plus any Haiku call | none |
| `--all` cached | adds ~40 ms | none |

Haiku runs through `claude -p` with no tools, no MCP servers, no settings, a short system prompt,
and `--no-session-persistence`, so its calls never show up as sessions.

Digests are cached in `~/.cache/claude-tabs/digests.json` (owner-only), keyed by transcript size
and modification time. Delete it any time.

## Development

```bash
npm test
```

No dependencies; Node runs the TypeScript directly.

### Releases

Every push to `main` runs the tests, then semantic-release reads the conventional commit
messages since the last tag and, when any warrant it, tags the next version (`fix:` patch,
`feat:` minor, `BREAKING CHANGE:` major) and publishes a GitHub release with notes. Nothing is
published to npm, and `package.json` keeps a placeholder version; the git tag is the version.

### Manual checks

iTerm2:

1. `ct --list <words from a tab title>` prints that tab with the right `tab N`.
2. `ct <words from a tab title>` switches to it.
3. `ct csv ingestion` (or any phrase matching two sessions) opens the fzf picker; Enter switches.
4. `ct --all <words from a closed session>` resumes it in a new tab.

WezTerm: the same four checks, run inside WezTerm.
