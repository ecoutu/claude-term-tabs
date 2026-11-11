/** Quote `s` as one POSIX shell word. */
export function shellQuote (s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}
