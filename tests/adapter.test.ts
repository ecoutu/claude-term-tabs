import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectAdapter } from '../src/terminals/adapter.ts'
import type { Exec } from '../src/types.ts'

const exec = (running: string[]): Exec => (cmd, args) => {
  if (cmd === 'pgrep') return { status: running.includes(args[args.length - 1]) ? 0 : 1, stdout: '', stderr: '' }
  if (cmd === 'wezterm') return { status: running.includes('wezterm') ? 0 : 127, stdout: '[]', stderr: '' }
  return { status: 1, stdout: '', stderr: '' }
}

test('TERM_PROGRAM iTerm.app picks iterm2', () =>
  assert.equal(detectAdapter({ TERM_PROGRAM: 'iTerm.app' }, exec([]))?.name, 'iterm2'))

test('override wins', () =>
  assert.equal(detectAdapter({ TERM_PROGRAM: 'iTerm.app' }, exec([]), 'wezterm')?.name, 'wezterm'))

test('unknown override throws', () =>
  assert.throws(() => detectAdapter({}, exec([]), 'kitty'), /kitty/))

test('vscode falls back to a running iTerm2', () =>
  assert.equal(detectAdapter({ TERM_PROGRAM: 'vscode' }, exec(['iTerm2']))?.name, 'iterm2'))

test('nothing running returns undefined', () =>
  assert.equal(detectAdapter({ TERM_PROGRAM: 'vscode' }, exec([])), undefined))
