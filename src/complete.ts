import { COMPLETE_FLAG, completions, isShell, SHELLS } from './args.ts'

export { COMPLETE_FLAG }

/**
 * Answer a completion script's `ctt --complete <shell> <words>` (`argv` is what follows the flag).
 * bin/claude-term-tabs calls this before loading the rest of ctt, so a Tab press stays fast. Returns the
 * exit code.
 */
export function answerCompletion (argv: string[], out: { stdout: (s: string) => void, stderr: (s: string) => void }): number {
  const [shell, ...words] = argv
  if (!isShell(shell)) {
    out.stderr(`claude-term-tabs: ${COMPLETE_FLAG} needs ${SHELLS.join(' or ')}, then the words to complete`)
    return 2
  }
  const offered = completions(shell, words)
  if (offered.length > 0) out.stdout(offered.join('\n'))
  return 0
}
