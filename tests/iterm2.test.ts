import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { iterm2Adapter, pickWindow } from '../src/terminals/iterm2.ts'
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

test('closePane ends the shell instead of closing the tab, so no confirmation prompt appears', () => {
  const { exec, calls } = recorder()
  iterm2Adapter(exec).closePane(pane)
  const script = calls[0].args[3]
  assert.match(script, /write\(\{ text: .exit. \}\)/)
  assert.doesNotMatch(script, /close\(\)/)
  assert.equal(calls[0].args[calls[0].args.length - 1], 'SID-1')
})

test('openPane returns the new session id', () => {
  const { exec } = recorder('NEW-ID\n')
  assert.equal(iterm2Adapter(exec).openPane('/x', 'cmd'), 'NEW-ID')
})

test('openPane passes the window target, opening in the current window by default', () => {
  const { exec, calls } = recorder('ID')
  const adapter = iterm2Adapter(exec)
  adapter.openPane('/x', 'cmd', { target: 'new' })
  adapter.openPane('/x', 'cmd', { target: 'main' })
  adapter.openPane('/x', 'cmd')
  assert.deepEqual(calls.map(c => c.args.slice(-3)), [['/x', 'cmd', 'new'], ['/x', 'cmd', 'main'], ['/x', 'cmd', 'current']])
})

interface FakeWindow { name: string, isHotkeyWindow: () => boolean }
const win = (name: string, hotkey = false): FakeWindow => ({ name, isHotkeyWindow: () => hotkey })
const app = (current: FakeWindow | null, windows: FakeWindow[]) => ({ currentWindow: () => current, windows: () => windows })
const asEmbedded = new Function(`return ${pickWindow.toString()}`)() as typeof pickWindow

for (const [label, pick] of [['pickWindow', pickWindow], ['pickWindow as embedded in the script', asEmbedded]] as const) {
  test(`${label}: current keeps today's behavior, even in the hotkey window`, () => {
    const hotkey = win('hotkey', true)
    assert.equal(pick(app(hotkey, [hotkey, win('main')]), 'current'), hotkey)
    assert.equal(pick(app(null, []), 'current'), null)
  })

  test(`${label}: new always asks for a new window`, () =>
    assert.equal(pick(app(win('main'), [win('main')]), 'new'), null))

  test(`${label}: main uses the current window when it is not the hotkey window`, () => {
    const main = win('main')
    assert.equal(pick(app(main, [win('hotkey', true), main]), 'main'), main)
  })

  test(`${label}: main from the hotkey window uses the frontmost other window`, () => {
    const hotkey = win('hotkey', true)
    const front = win('front')
    assert.equal(pick(app(hotkey, [hotkey, front, win('back')]), 'main'), front)
  })

  test(`${label}: main asks for a new window when the hotkey window is the only one`, () => {
    const hotkey = win('hotkey', true)
    assert.equal(pick(app(hotkey, [hotkey]), 'main'), null)
  })

  test(`${label}: main skips a window that cannot say whether it is the hotkey window`, () => {
    const broken = { name: 'broken', isHotkeyWindow: () => { throw new Error('gone') } }
    const ok = win('ok')
    assert.equal(pick(app(broken, [broken, ok]), 'main'), ok)
  })
}
