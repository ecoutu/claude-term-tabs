import type { Exec, Pane } from '../types.ts'
import type { TerminalAdapter } from './adapter.ts'

const LIST_SCRIPT = `function run () {
  const app = Application('iTerm2')
  const out = []
  let shown = 0
  for (const w of app.windows()) {
    let wid, ids, ttys, names
    try {
      wid = String(w.id())
      ids = w.tabs.sessions.id()
      ttys = w.tabs.sessions.tty()
      names = w.tabs.sessions.name()
    } catch (e) {
      continue
    }
    shown++
    ids.forEach((tabIds, ti) => tabIds.forEach((id, si) => out.push({
      id, tty: ttys[ti][si], title: names[ti][si], windowId: wid, windowIndex: shown, tabIndex: ti + 1
    })))
  }
  return JSON.stringify(out)
}`

const sessionScript = (onFound: string): string => `function run (argv) {
  const app = Application('iTerm2')
  for (const w of app.windows()) {
    let tabs
    try { tabs = w.tabs() } catch (e) { continue }
    for (const t of tabs) {
      for (const s of t.sessions()) {
        if (s.id() === argv[0]) {
          ${onFound}
          return 'ok'
        }
      }
    }
  }
  throw new Error('session not found: ' + argv[0])
}`

const FOCUS_SCRIPT = sessionScript('s.select(); t.select(); w.select(); app.activate()')
const SEND_SCRIPT = sessionScript('s.write({ text: argv[1], newline: false }); delay(0.3); s.write({ text: "" })')
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const CLOSE_SCRIPT = sessionScript("s.write({ text: 'exit' })")

const OPEN_SCRIPT = `function run (argv) {
  const app = Application('iTerm2')
  const quoted = "'" + argv[0].split("'").join("'\\\\''") + "'"
  const fresh = argv[2] === 'new-window' || !app.currentWindow()
  const session = fresh
    ? app.createWindowWithDefaultProfile().currentSession()
    : app.currentWindow().createTabWithDefaultProfile().currentSession()
  session.write({ text: 'cd ' + quoted + ' && ' + argv[1] })
  app.activate()
  return session.id()
}`

const AUTOMATION_HINT = 'iTerm2 refused automation. Allow your terminal to control iTerm2 in System Settings > Privacy & Security > Automation.'

/** iTerm2 adapter driven by JXA through osascript. */
export function iterm2Adapter (exec: Exec): TerminalAdapter {
  const jxa = (script: string, args: string[] = []): string => {
    const r = exec('osascript', ['-l', 'JavaScript', '-e', script, ...args])
    if (r.status === 0) return r.stdout
    if (r.stderr.includes('-1743')) throw new Error(AUTOMATION_HINT)
    throw new Error(`osascript failed (${r.status}): ${r.stderr.trim()}`)
  }
  return {
    name: 'iterm2',
    listPanes: () => JSON.parse(jxa(LIST_SCRIPT)) as Pane[],
    focus: (pane) => { jxa(FOCUS_SCRIPT, [pane.id]) },
    sendText: (pane, text) => { jxa(SEND_SCRIPT, [pane.id, `${PASTE_START}${text}${PASTE_END}`]) },
    closePane: (pane) => { jxa(CLOSE_SCRIPT, [pane.id]) },
    openPane: (cwd, command, opts) => jxa(OPEN_SCRIPT, [cwd, command, opts?.newWindow === true ? 'new-window' : 'tab']).trim()
  }
}
