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
  assert.deepEqual(calls[0].args.slice(-2), ["/x/it's", 'claude --resume S'])
})

test('automation permission denial names the fix', () => {
  const { exec } = recorder('', 1, 'execution error: Not authorized to send Apple events to iTerm2. (-1743)')
  assert.throws(() => iterm2Adapter(exec).listPanes(), /Privacy & Security > Automation/)
})

test('other osascript failures throw with stderr', () => {
  const { exec } = recorder('', 1, 'boom')
  assert.throws(() => iterm2Adapter(exec).listPanes(), /boom/)
})
