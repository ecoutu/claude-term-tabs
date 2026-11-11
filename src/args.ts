import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { shellQuote } from './shell.ts'
import { TERMINAL_NAMES } from './terminals/adapter.ts'

/** One flag. `--help` text, tab completion and parsing all read the same table. */
export interface Flag {
  describe: string
  /** Placeholder shown in `--help` (NAME, MIN, FILE); a flag without one is a boolean. */
  value?: string
  short?: string
  /** Values offered after the flag by tab completion; never validated. */
  choices?: readonly string[]
}

export type Flags = Readonly<Record<string, Flag>>

/** Parsed values: a string (or undefined) for a flag that takes a value, else a boolean. */
type Values<T extends Flags> = { -readonly [K in keyof T]: T[K] extends { value: string } ? string | undefined : boolean }

const HELP_FLAG = { short: 'h', describe: 'show this help' } as const satisfies Flag

/** Flags of the search, `ctt [query...]`. */
export const SEARCH_FLAGS = {
  list: { describe: 'print matches, never switch' },
  all: { describe: 'include closed sessions (choosing one resumes it in a new tab)' },
  json: { describe: 'machine-readable output (implies --list)' },
  'no-llm': { describe: 'local matching only, never call Haiku' },
  terminal: { value: 'NAME', describe: `${TERMINAL_NAMES.join(' | ')} (default: detected)`, choices: TERMINAL_NAMES },
  help: HELP_FLAG
} as const satisfies Flags

/** Flags of `ctt pause`. */
export const PAUSE_FLAGS = {
  'auto-close': { describe: 'also exit each session and close its tab after its HANDOFF' },
  timeout: { value: 'MIN', describe: 'minutes to wait (default: pauseTimeoutMinutes, else 10)' },
  help: HELP_FLAG
} as const satisfies Flags

/** Flags of `ctt resume`. */
export const RESUME_FLAGS = {
  'dry-run': { describe: 'print the commands instead' },
  'no-prompt': { describe: 'reopen without sending the resume prompt' },
  snapshot: { value: 'FILE', describe: 'use this snapshot instead of the latest' },
  help: HELP_FLAG
} as const satisfies Flags

/** Shells `ctt completion` writes a script for. */
export const SHELLS = ['bash', 'zsh'] as const
export type Shell = typeof SHELLS[number]

export function isShell (s: string | undefined): s is Shell {
  return SHELLS.some(x => x === s)
}

/** The public subcommands. The internal `_focus` and `_send-stop` are deliberately not here. */
export const COMMANDS = {
  pause: { describe: 'before a restart, record live sessions and ask each for a HANDOFF', flags: PAUSE_FLAGS },
  resume: { describe: 'after a restart, reopen recorded sessions in window and tab order', flags: RESUME_FLAGS },
  completion: { describe: `print the tab-completion script for ${SHELLS.join(' or ')} (default: from $SHELL)`, flags: { help: HELP_FLAG }, args: `[${SHELLS.join('|')}]` }
} as const satisfies Readonly<Record<string, { describe: string, flags: Flags, args?: string }>>

export type Command = keyof typeof COMMANDS

export function isCommand (word: string | undefined): word is Command {
  return word !== undefined && Object.hasOwn(COMMANDS, word)
}

/** The hidden first argument the completion scripts call ctt with: `ctt --complete <shell> <words>`. */
export const COMPLETE_FLAG = '--complete'

/**
 * Parse `argv` against `flags` with `node:util` `parseArgs` in strict mode: unknown flags, a value
 * given to a boolean flag and a missing value throw, and so do positionals unless `positionals` is set.
 */
export function parseFlags<T extends Flags> (argv: string[], flags: T, opts: { positionals?: boolean } = {}): { values: Values<T>, positionals: string[] } {
  const options: ParseArgsOptionsConfig = Object.fromEntries(Object.entries(flags).map(([name, f]) => [name, {
    ...(f.value !== undefined ? { type: 'string' } : { type: 'boolean', default: false }),
    ...(f.short !== undefined ? { short: f.short } : {})
  }]))
  const { values, positionals } = parseArgs({ args: argv, options, strict: true, allowPositionals: opts.positionals === true })
  return { values: values as Values<T>, positionals }
}

/** The flag whose value is being completed, if any: `--terminal x`, bash's `--terminal = x`, or zsh's `--terminal=x`. */
function valueBeingCompleted (before: string[], current: string): { flag: string, value: string, prefix: string } | undefined {
  const joined = /^--([^=]+)=(.*)$/.exec(current)
  if (joined !== null) return { flag: joined[1], value: joined[2], prefix: `--${joined[1]}=` }
  const [flag, value] = current === '=' ? [before.at(-1), ''] : before.at(-1) === '=' ? [before.at(-2), current] : [before.at(-1), current]
  return flag?.startsWith('--') === true ? { flag: flag.slice(2), value, prefix: '' } : undefined
}

/** `name` for bash; for zsh's `_describe`, `name` with its colons escaped, then `:description` if any. */
export function entry (shell: Shell, name: string, describe?: string): string {
  if (shell === 'bash') return name
  const escaped = name.replaceAll(':', '\\:')
  return describe === undefined ? escaped : `${escaped}:${describe}`
}

/** Names of the flags already on the line, however given: `--name`, `--name=value`, or a short `-h`. */
function given (before: string[], flags: Flags): Set<string> {
  const names = new Set<string>()
  for (const word of before) {
    if (word.startsWith('--')) names.add(word.slice(2).split('=')[0])
    else if (/^-[^-]/.test(word)) {
      for (const short of word.slice(1)) {
        const name = Object.entries(flags).find(([, f]) => f.short === short)?.[0]
        if (name !== undefined) names.add(name)
      }
    }
  }
  return names
}

/**
 * Answer the completion script's `ctt --complete <shell> <words>`, where `words` is the command line up
 * to the word being completed (the program name first). Subcommands are offered only as the first word;
 * flags (long form) when the word starts with `-`, minus those already given; a flag that takes a value
 * offers its choices or nothing, so the shell falls back to file names; nothing after `--`.
 */
export function completions (shell: Shell, words: string[]): string[] {
  const typed = words.slice(1)
  const current = typed.at(-1) ?? ''
  const before = typed.slice(0, -1)
  if (before.includes('--')) return []
  const command = isCommand(before[0]) ? before[0] : undefined
  const flags: Flags = command !== undefined ? COMMANDS[command].flags : SEARCH_FLAGS
  const value = valueBeingCompleted(before, current)
  const flag = value !== undefined && Object.hasOwn(flags, value.flag) ? flags[value.flag] : undefined
  if (value !== undefined && flag?.value !== undefined) {
    return (flag.choices ?? []).filter(c => c.startsWith(value.value)).map(c => entry(shell, value.prefix + c))
  }
  if (current.startsWith('-')) {
    const already = given(before, flags)
    return Object.entries(flags)
      .filter(([name]) => `--${name}`.startsWith(current) && !already.has(name))
      .map(([name, f]) => entry(shell, `--${name}`, f.describe))
  }
  if (before.length === 0) {
    return Object.entries(COMMANDS).filter(([name]) => name.startsWith(current)).map(([name, c]) => entry(shell, name, c.describe))
  }
  if (command === 'completion' && before.length === 1) return SHELLS.filter(s => s.startsWith(current)).map(s => entry(shell, s))
  return []
}

/**
 * The completion script for `shell`. It registers both `ctt` and `claude-term-tabs`, and runs `program`
 * (ctt's own path) to answer each request. Adapted from yargs' scripts (MIT).
 */
export function completionScript (shell: Shell, program: string): string {
  const ctt = `${shellQuote(program)} ${COMPLETE_FLAG} ${shell}`
  if (shell === 'zsh') {
    return `#compdef ctt claude-term-tabs
###-begin-ctt-completions-###
#
# ctt tab completion for zsh. Install: ctt completion zsh >> ~/.zshrc (after compinit)
#
_ctt_completions()
{
  local reply
  local si=$IFS
  IFS=$'\\n' reply=($(${ctt} "\${words[@]:0:$CURRENT}"))
  IFS=$si
  if [[ \${#reply} -gt 0 ]]; then
    _describe 'values' reply
  else
    # nothing to offer: complete file names, after the = of --flag=value
    [[ $PREFIX == --*=* ]] && compset -P '*='
    _default
  fi
}
if [[ "\${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _ctt_completions "$@"
else
  compdef _ctt_completions ctt claude-term-tabs
fi
###-end-ctt-completions-###`
  }
  return `###-begin-ctt-completions-###
#
# ctt tab completion for bash 4 or later. Install: ctt completion bash >> ~/.bashrc
#
_ctt_completions()
{
    local cur_word type_list
    cur_word="\${COMP_WORDS[COMP_CWORD]}"
    # bash splits --terminal=w into --terminal, = and w
    [[ $cur_word == = ]] && cur_word=''
    mapfile -t type_list < <(${ctt} "\${COMP_WORDS[@]:0:COMP_CWORD+1}")
    # nothing to offer: leave COMPREPLY empty so bash completes file names
    if [[ \${#type_list[@]} -eq 0 ]]; then
      COMPREPLY=()
      return 0
    fi
    mapfile -t COMPREPLY < <(compgen -W "$( printf '%q ' "\${type_list[@]}" )" -- "\${cur_word}")
}
complete -o bashdefault -o default -F _ctt_completions ctt claude-term-tabs
###-end-ctt-completions-###`
}
