import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { formatAge, formatPickerLine, parsePickerSelection, pick } from '../src/picker.ts'
import type { Candidate, Exec } from '../src/types.ts'

const NOW = 1_800_000_000_000
const cand = (id: string, extra: Partial<Candidate> = {}, title = '✳ Envoy "api"\tidentity · staging'): Candidate => ({
  live: true,
  status: 'idle',
  digest: { sessionId: id, cwd: '/x/api-proxy', repo: 'api-proxy', branch: 'main', title, lastActive: NOW - 5 * 60_000 },
  ...extra
})

test('line is id, tab, then sanitized fields', () =>
  assert.equal(formatPickerLine(cand('S1'), undefined, NOW),
    'S1\t✳ Envoy "api" identity · staging · api-proxy · main · 5m · idle'))

test('summary, tab position and dir gone are appended', () => {
  const pane = { id: 'p', tty: '/dev/ttys1', title: '', windowId: '1', windowIndex: 1, tabIndex: 4 }
  assert.equal(formatPickerLine(cand('S1', { pane }), 'fixing envoy', NOW),
    'S1\t✳ Envoy "api" identity · staging · api-proxy · main · 5m · idle · tab 4 · fixing envoy')
  assert.match(formatPickerLine(cand('S2', { live: false, dirGone: true }), undefined, NOW), / · closed · dir gone$/)
})

test('selection returns the id even with odd titles', () =>
  assert.equal(parsePickerSelection(formatPickerLine(cand('abc-123'), undefined, NOW) + '\n'), 'abc-123'))

test('ages format as minutes, hours, days', () => {
  assert.equal(formatAge(NOW - 30_000, NOW), '0m')
  assert.equal(formatAge(NOW - 3 * 3_600_000, NOW), '3h')
  assert.equal(formatAge(NOW - 2 * 86_400_000, NOW), '2d')
})

test('fzf selection maps back to the candidate', () => {
  const cands = [cand('S1'), cand('S2')]
  const exec: Exec = (cmd, _args, input) => {
    assert.equal(cmd, 'fzf')
    return { status: 0, stdout: (input ?? '').split('\n')[1] + '\n', stderr: '' }
  }
  assert.equal(pick(cands, new Map(), exec, { hasFzf: true, prompt: () => '' })?.digest.sessionId, 'S2')
})

test('fzf escape returns undefined', () => {
  const exec: Exec = () => ({ status: 130, stdout: '', stderr: '' })
  assert.equal(pick([cand('S1')], new Map(), exec, { hasFzf: true, prompt: () => '' }), undefined)
})

test('numbered fallback picks by number and empty input cancels', () => {
  const cands = [cand('S1'), cand('S2')]
  const exec: Exec = () => { throw new Error('no exec expected') }
  assert.equal(pick(cands, new Map(), exec, { hasFzf: false, prompt: () => '2' })?.digest.sessionId, 'S2')
  assert.equal(pick(cands, new Map(), exec, { hasFzf: false, prompt: () => '' }), undefined)
  assert.equal(pick(cands, new Map(), exec, { hasFzf: false, prompt: () => '9' }), undefined)
})

test('preview text strips escape sequences and control characters', () => {
  const c = cand('S1')
  const evil = { ...c, digest: { ...c.digest, firstPrompt: 'hi\x1b]52;c;cGF3bmVk\x07there\x9b31m', lastPrompt: 'a\rb' } }
  let preview = ''
  const exec: Exec = (_cmd, args) => {
    const cmd = args[args.indexOf('--preview') + 1]
    preview = readFileSync(cmd.replace(/^cat /, '').replace('{1}', 'S1'), 'utf8')
    return { status: 130, stdout: '', stderr: '' }
  }
  pick([evil], new Map(), exec, { hasFzf: true, prompt: () => '' })
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(preview), JSON.stringify(preview))
  assert.match(preview, /first:\s+hi.*there/)
})
