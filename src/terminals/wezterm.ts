import type { Exec, Pane } from '../types.ts'
import type { TerminalAdapter } from './adapter.ts'

interface WeztermPane { window_id: number, tab_id: number, pane_id: number, title: string, tty_name?: string }

/** WezTerm adapter driven by `wezterm cli`. */
export function weztermAdapter (exec: Exec, shell: string = process.env.SHELL ?? '/bin/sh'): TerminalAdapter {
  const cli = (args: string[]): string => {
    const r = exec('wezterm', ['cli', ...args])
    if (r.status !== 0) throw new Error(`wezterm cli ${args[0]} failed (${r.status}): ${r.stderr.trim()}`)
    return r.stdout
  }
  return {
    name: 'wezterm',
    listPanes: () => toPanes(JSON.parse(cli(['list', '--format', 'json'])) as WeztermPane[]),
    focus: (pane) => { cli(['activate-pane', '--pane-id', pane.id]) },
    sendText: (pane, text) => { cli(['send-text', '--pane-id', pane.id, '--no-paste', `${text}\r`]) },
    closePane: (pane) => { cli(['kill-pane', '--pane-id', pane.id]) },
    openPane: (cwd, command, opts) => {
      cli(['spawn', ...(opts?.newWindow === true ? ['--new-window'] : []), '--cwd', cwd, '--', shell, '-lc', `${command}; exec ${shell} -l`])
    }
  }
}

function toPanes (raw: WeztermPane[]): Pane[] {
  const windows = [...new Set(raw.map(p => p.window_id))]
  const tabsByWindow = new Map(windows.map(w => [w, [...new Set(raw.filter(p => p.window_id === w).map(p => p.tab_id))]]))
  return raw.map(p => ({
    id: String(p.pane_id),
    tty: p.tty_name ?? '',
    title: p.title,
    windowId: String(p.window_id),
    windowIndex: windows.indexOf(p.window_id) + 1,
    tabIndex: (tabsByWindow.get(p.window_id) ?? []).indexOf(p.tab_id) + 1
  }))
}
