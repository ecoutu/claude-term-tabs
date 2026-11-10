import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { iterm2Adapter } from '../src/terminals/iterm2.ts'
import type { Exec, Pane } from '../src/types.ts'
import { fixture } from './helpers.ts'

const panesJson = readFileSync(fixture('iterm2-panes.json'), 'utf8')
const recorder = (stdout = '', status = 0, stderr = '') => {
  const calls: Array<{ cmd: string, args: string[] }> = []
  const exec: Exec = (cmd, args) => { calls.push({ cmd, args }); return { status, stdout, stderr } }
  return { calls, exec }
}

test('listPanes parses JXA output', () => {
  const { exec, calls } = recorder(panesJson)
  const panes = iterm2Adapter(exec).listPanes()
  assert.equal(panes.length, 3)
  assert.deepEqual(panes[2], { id: '76A2DDC7', tty: '/dev/ttys000', title: '~ (-zsh)', windowId: '200', windowIndex: 2, tabIndex: 1 })
  assert.equal(calls[0].cmd, 'osascript')
  assert.deepEqual(calls[0].args.slice(0, 2), ['-l', 'JavaScript'])
})

test('focus passes the session id as an argument, not script text', () => {
  const { exec, calls } = recorder()
  const pane: Pane = { id: 'AB"C', tty: '/dev/ttys004', title: 't', windowId: '1', windowIndex: 1, tabIndex: 1 }
  iterm2Adapter(exec).focus(pane)
  const { args } = calls[0]
  assert.equal(args[args.length - 1], 'AB"C')
  assert.ok(!args[3].includes('AB"C'))
})

test('openPane passes cwd and command as arguments', () => {
  const { exec, calls } = recorder()
  iterm2Adapter(exec).openPane("/x/it's", 'claude --resume S')
  assert.deepEqual(calls[0].args.slice(-3, -1), ["/x/it's", 'claude --resume S'])
})

test('automation permission denial names the fix', () => {
  const { exec } = recorder('', 1, 'execution error: Not authorized to send Apple events to iTerm2. (-1743)')
  assert.throws(() => iterm2Adapter(exec).listPanes(), /Privacy & Security > Automation/)
})

test('other osascript failures throw with stderr', () => {
  const { exec } = recorder('', 1, 'boom')
  assert.throws(() => iterm2Adapter(exec).listPanes(), /boom/)
})

const pane: Pane = { id: 'SID-1', tty: '/dev/ttys004', title: 't', windowId: '1', windowIndex: 1, tabIndex: 1 }

test('sendText pastes the text as one bracketed paste and passes it as an argument', () => {
  const { exec, calls } = recorder()
  const text = 'Pause "now"\nthen $HOME'
  iterm2Adapter(exec).sendText(pane, text)
  assert.deepEqual(calls[0].args.slice(-2), ['SID-1', `\x1b[200~${text}\x1b[201~`])
  assert.ok(!calls[0].args[3].includes('Pause'))
})

test('closePane passes the session id', () => {
  const { exec, calls } = recorder()
  iterm2Adapter(exec).closePane(pane)
  assert.equal(calls[0].args[calls[0].args.length - 1], 'SID-1')
})

test('openPane returns the new session id', () => {
  const { exec } = recorder('NEW-ID\n')
  assert.equal(iterm2Adapter(exec).openPane('/x', 'cmd'), 'NEW-ID')
})

test('openPane with newWindow adds a new-window argument', () => {
  const { exec, calls } = recorder('ID')
  iterm2Adapter(exec).openPane('/x', 'cmd', { newWindow: true })
  assert.deepEqual(calls[0].args.slice(-3), ['/x', 'cmd', 'new-window'])
  iterm2Adapter(exec).openPane('/x', 'cmd')
  assert.deepEqual(calls[1].args.slice(-3), ['/x', 'cmd', 'tab'])
})
