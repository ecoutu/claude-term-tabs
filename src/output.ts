import { writeSync } from 'node:fs'

const pause = new Int32Array(new SharedArrayBuffer(4))

/**
 * A line writer for fd that writes every byte. A short write or EAGAIN (a non-blocking pipe that is
 * full) is retried; once the reader has gone (EPIPE, as in `ct --json | head`), the rest of the
 * output is dropped without an error and ct carries on.
 */
export function lineWriter (fd: number): (s: string) => void {
  let closed = false
  return s => {
    const buf = Buffer.from(`${s}\n`)
    let off = 0
    while (!closed && off < buf.length) {
      let n = 0
      try {
        n = writeSync(fd, buf, off)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EPIPE') closed = true
        else if (code !== 'EAGAIN') throw err
      }
      off += n
      if (n === 0 && !closed) Atomics.wait(pause, 0, 0, 5) // the reader is behind (EAGAIN or no progress); wait without spinning
    }
  }
}
