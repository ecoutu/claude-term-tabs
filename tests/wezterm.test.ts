import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { weztermAdapter } from '../src/terminals/wezterm.ts'
import type { Exec, Pane } from '../src/types.ts'
import { fixture } from './helpers.ts'

const listJson = readFileSync(fixture('wezterm-list.json'), 'utf8')
const recorder = (stdout = '', status = 0) => {
  const calls: Array<{ cmd: string, args: string[] }> = []
  const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status, stdout, stderr: status === 0 ? '' : 'no gui' } }
  return { calls, exec }
}

test('listPanes maps tty and orders windows and tabs from 1', () => {
  const panes = weztermAdapter(recorder(listJson).exec).listPanes()
  assert.deepEqual(panes.map(p => [p.id, p.tty, p.windowIndex, p.tabIndex]), [
    ['21', '/dev/ttys003', 1, 1],
    ['22', '/dev/ttys004', 1, 2],
    ['23', '/dev/ttys005', 1, 2],
    ['40', '/dev/ttys006', 2, 1]
  ])
  assert.equal(panes[0].windowId, '3')
})

test('focus activates the pane by id', () => {
  const { exec, calls } = recorder()
  const pane: Pane = { id: '22', tty: '/dev/ttys004', title: '', windowId: '3', windowIndex: 1, tabIndex: 2 }
  weztermAdapter(exec).focus(pane)
  assert.deepEqual(calls[0], { cmd: 'wezterm', args: ['cli', 'activate-pane', '--pane-id', '22'] })
})


test('wezterm failure throws', () =>
  assert.throws(() => weztermAdapter(recorder('', 1).exec).listPanes(), /wezterm/))

test('openPane runs through a login shell and keeps the pane open afterwards', () => {
  const { exec, calls } = recorder()
  weztermAdapter(exec, '/bin/zsh').openPane('/x', 'claude --resume S')
  assert.deepEqual(calls[0].args, ['cli', 'spawn', '--cwd', '/x', '--', '/bin/zsh', '-lc', 'claude --resume S; exec /bin/zsh -l'])
})

const wpane: Pane = { id: '22', tty: '/dev/ttys004', title: '', windowId: '3', windowIndex: 1, tabIndex: 2 }

test('sendText pastes the text, then submits with a bare carriage return', () => {
  const { exec, calls } = recorder()
  weztermAdapter(exec, '/bin/zsh').sendText(wpane, 'hi "there"\nline 2')
  assert.deepEqual(calls[0].args, ['cli', 'send-text', '--pane-id', '22', 'hi "there"\nline 2'])
  assert.deepEqual(calls[1].args, ['cli', 'send-text', '--pane-id', '22', '--no-paste', '\r'])
})

test('closePane kills the pane', () => {
  const { exec, calls } = recorder()
  weztermAdapter(exec, '/bin/zsh').closePane(wpane)
  assert.deepEqual(calls[0].args, ['cli', 'kill-pane', '--pane-id', '22'])
})

test('openPane returns the spawned pane id', () => {
  const { exec } = recorder('41\n')
  assert.equal(weztermAdapter(exec, '/bin/zsh').openPane('/x', 'c'), '41')
})

test('openPane with newWindow spawns a new window', () => {
  const { exec, calls } = recorder()
  weztermAdapter(exec, '/bin/zsh').openPane('/x', 'c', { newWindow: true })
  assert.deepEqual(calls[0].args.slice(0, 3), ['cli', 'spawn', '--new-window'])
})

test('openPane after a new window opens its tab in that window, not the caller\'s', () => {
  const calls: string[][] = []
  const exec: Exec = (_cmd, args) => {
    calls.push(args)
    return { status: 0, stdout: args[1] === 'list' ? listJson : '40\n', stderr: '' }
  }
  const adapter = weztermAdapter(exec, '/bin/zsh')
  adapter.openPane('/x', 'a', { newWindow: true })
  adapter.openPane('/y', 'b')
  assert.deepEqual(calls.filter(a => a[1] === 'spawn')[1].slice(0, 4), ['cli', 'spawn', '--window-id', '7'])
})

test('a failed new window does not send the next tabs to the previous new window', () => {
  const spawns: string[][] = []
  let failNext = false
  const exec: Exec = (_cmd, args) => {
    if (args[1] === 'list') return { status: 0, stdout: listJson, stderr: '' }
    spawns.push(args)
    if (failNext) return { status: 1, stdout: '', stderr: 'no gui' }
    return { status: 0, stdout: '40\n', stderr: '' }
  }
  const adapter = weztermAdapter(exec, '/bin/zsh')
  adapter.openPane('/x', 'a', { newWindow: true })
  failNext = true
  assert.throws(() => adapter.openPane('/y', 'b', { newWindow: true }))
  failNext = false
  adapter.openPane('/z', 'c')
  assert.equal(spawns[2].includes('--window-id'), false)
})

test('openPane without an earlier new window opens in the caller\'s window', () => {
  const { exec, calls } = recorder('41\n')
  weztermAdapter(exec, '/bin/zsh').openPane('/x', 'c')
  assert.equal(calls.some(c => c.args.includes('--window-id')), false)
})
