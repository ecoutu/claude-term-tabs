/** Usage text for ct and its subcommands. */
export const HELP = `usage: ct [query...] [options]
       ct pause [--auto-close] [--timeout MIN]
       ct resume [--dry-run] [--no-prompt] [--snapshot FILE]

Find a Claude Code session by what you remember and switch to its tab.

  --list           print matches, never switch
  --all            include closed sessions (choosing one resumes it in a new tab)
  --json           machine-readable output (implies --list)
  --no-llm         local matching only, never call Haiku
  --terminal NAME  iterm2 | wezterm (default: detected)
  -h, --help       show this help

ct pause: before a restart, record live sessions and ask each for a HANDOFF.
  --auto-close     also exit each session and close its tab after its HANDOFF
  --timeout MIN    minutes to wait (default: pauseTimeoutMinutes, else 10)

ct resume: after a restart, reopen recorded sessions in window and tab order.
  --dry-run        print the commands instead
  --no-prompt      reopen without sending the resume prompt
  --snapshot FILE  use this snapshot instead of the latest

Use ct -- pause to search for the word "pause".

Config: ~/.config/claude-tabs/config.json  {"resumeCommand": "claude --resume {id}", "excludeDirs": ["~/scratch"]}`
