import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Atomically write `text` to `file` as 0600, creating or tightening its directory to 0700. */
export function writeOwnerOnly (file: string, text: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}
