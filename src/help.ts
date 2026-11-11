import { COMMANDS, SEARCH_FLAGS, type Flags } from './args.ts'

const MIN_COLUMN = 17

/**
 * One line per flag, from the same table that parsing and tab completion use. Descriptions start in a
 * column at least 17 wide and two spaces past the longest label. Subcommand sections leave out
 * -h/--help, which the search section already lists.
 */
export function flagLines (flags: Flags, opts: { help?: boolean } = {}): string {
  const rows = Object.entries(flags).filter(([name]) => opts.help !== false || name !== 'help').map(([name, f]) =>
    [`${f.short !== undefined ? `-${f.short}, ` : ''}--${name}${f.value !== undefined ? ` ${f.value}` : ''}`, f.describe])
  const column = Math.max(MIN_COLUMN, ...rows.map(([label]) => label.length + 2))
  return rows.map(([label, describe]) => `  ${label.padEnd(column)}${describe}`).join('\n')
}

/** `ctt pause [--auto-close] [--timeout MIN]`, from a subcommand's table; -h/--help left out. */
function usage (name: keyof typeof COMMANDS): string {
  const c: { flags: Flags, args?: string } = COMMANDS[name]
  const flags = Object.entries(c.flags).filter(([flag]) => flag !== 'help').map(([flag, f]) => `[--${flag}${f.value !== undefined ? ` ${f.value}` : ''}]`)
  return ['ctt', name, ...flags, ...(c.args !== undefined ? [c.args] : [])].join(' ')
}

/** Usage text for ctt and its subcommands. */
export const HELP = `usage: ctt [query...] [options]
${Object.keys(COMMANDS).map(name => `       ${usage(name as keyof typeof COMMANDS)}`).join('\n')}

Find a Claude Code session by what you remember and switch to its tab.

${flagLines(SEARCH_FLAGS)}

ctt pause: ${COMMANDS.pause.describe}.
${flagLines(COMMANDS.pause.flags, { help: false })}

ctt resume: ${COMMANDS.resume.describe}.
${flagLines(COMMANDS.resume.flags, { help: false })}

ctt completion: ${COMMANDS.completion.describe}.
  ctt completion zsh >> ~/.zshrc, or ctt completion bash >> ~/.bashrc (bash 4 or later)

Use ctt -- pause to search for the word "pause".

Config: ~/.config/claude-term-tabs/config.json  {"resumeCommand": "claude --resume {id}", "excludeDirs": ["~/scratch"]}`
