import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const cli = join(root, 'src', 'cli.ts')
const output = join(root, 'src', 'output.ts')
const writeBig = `const { realDeps } = await import(${JSON.stringify(cli)}); const d = realDeps(); d.stdout('x'.repeat(300000)); d.stdout('done')`

/** Runs node -e script | reader under pipefail, so a crash in node fails the pipeline too. */
const pipeline = (script: string, reader: string) => {
  const r = spawnSync('bash', ['-c', `set -o pipefail; "$0" --input-type=module -e "$1" | ${reader}`, process.execPath, script], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr }
}

test('output written to a pipe arrives whole, past the 64 KiB pipe buffer', () => {
  // The reader starts late, so the pipe fills while ctt is still writing.
  const r = pipeline(writeBig, '(sleep 1; wc -c)')
  assert.equal(r.stderr, '')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, String(300001 + 5))
})

test('a reader that stops early ends the output quietly', () => {
  const r = pipeline(writeBig, 'head -c 10')
  assert.equal(r.stderr, '')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'x'.repeat(10))
})

test('a pipe already made non-blocking is retried until every byte is out', () => {
  // Touching process.stdout makes a piped fd 1 non-blocking, so a full pipe throws EAGAIN.
  const script = `process.stdout.isTTY; const { lineWriter } = await import(${JSON.stringify(output)}); lineWriter(1)('x'.repeat(300000))`
  const r = pipeline(script, '(sleep 1; wc -c)')
  assert.equal(r.stderr, '')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, String(300001))
})

test('a completion request answers through a pipe', () => {
  const r = spawnSync('bash', ['-c', 'set -o pipefail; "$0" --complete bash ctt pa | cat', join(root, 'bin', 'claude-term-tabs')], { encoding: 'utf8' })
  assert.equal(r.stderr, '')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'pause\n')
})

test('realDeps leaves a piped stdout blocking', { skip: !existsSync('/proc/self/fdinfo') && 'needs Linux /proc' }, () => {
  // O_NONBLOCK is 04000 in the octal flags of /proc/self/fdinfo/1.
  const script = `const { realDeps } = await import(${JSON.stringify(cli)}); realDeps(); const { readFileSync } = await import('node:fs'); const flags = /flags:\\s+(\\d+)/.exec(readFileSync('/proc/self/fdinfo/1', 'utf8'))[1]; console.error((parseInt(flags, 8) & 0o4000) ? 'nonblocking' : 'blocking')`
  const r = pipeline(script, 'cat')
  assert.equal(r.stderr.trim(), 'blocking')
})
