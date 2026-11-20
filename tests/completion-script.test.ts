import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completionScript } from '../src/args.ts'

const hasZsh = spawnSync('zsh', ['-fc', 'true']).status === 0
const needsZsh = { skip: !hasZsh && process.env.CI === undefined && 'zsh is not installed' }

/** Run `body` in an interactive zsh that has sourced the zsh script, with ctt replaced by the shell script `fakeCtt`. */
function inZsh (fakeCtt: string, body: string[]): { stdout: string, stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ctt-complete-'))
  try {
    const program = join(dir, 'fake-ctt')
    writeFileSync(program, `#!/bin/sh\n${fakeCtt}\n`)
    chmodSync(program, 0o755)
    const script = join(dir, '_ctt')
    writeFileSync(script, completionScript('zsh', program))
    const r = spawnSync('zsh', ['-fic', [
      'compdef () { : }; _default () { : }',
      `source ${script}`,
      'export CTT_TEST_SHELL=$$',
      ...body
    ].join('\n')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('an interrupted zsh completion leaves the shell IFS as it was', needsZsh, () => {
  const r = inZsh('kill -INT "$CTT_TEST_SHELL"\nsleep 1', [
    '_describe () { : }',
    'words=(ctt ""); CURRENT=2',
    '{ _ctt_completions } always { TRY_BLOCK_INTERRUPT=0 }',
    'print -r -- "${(q)IFS}"'
  ])
  assert.equal(r.stdout.trim(), "\\ $'\\t'$'\\n'$'\\0'", r.stderr)
})

test('zsh completion offers its matches even when a style hook assigns reply', needsZsh, () => {
  const r = inZsh("printf '%s\\n' '--all:include closed sessions' '--json:machine-readable output'", [
    '_describe () { reply=(clobbered); print -rl -- "${(@P)2}" }',
    'words=(ctt --); CURRENT=2',
    '_ctt_completions'
  ])
  assert.deepEqual(r.stdout.trim().split('\n'), ['--all:include closed sessions', '--json:machine-readable output'], r.stderr)
})
