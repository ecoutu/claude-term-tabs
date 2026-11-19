import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { formatAge, formatPickerLine, parsePickerSelection, pick, pickMany } from '../src/picker.ts'
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
    preview = readFileSync(cmd.replace(/^cat '([^']+)'\/\{1\}$/, '$1/S1'), 'utf8')
    return { status: 130, stdout: '', stderr: '' }
  }
  pick([evil], new Map(), exec, { hasFzf: true, prompt: () => '' })
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(preview), JSON.stringify(preview))
  assert.match(preview, /first:\s+hi.*there/)
})

test('preview command quotes a temp path containing spaces', () => {
  let previewCmd = ''
  const exec: Exec = (_c, args) => { previewCmd = args[args.indexOf('--preview') + 1]; return { status: 130, stdout: '', stderr: '' } }
  pick([cand('S1')], new Map(), exec, { hasFzf: true, prompt: () => '' })
  assert.match(previewCmd, /^cat '[^']+'\/\{1\}$/)
})

test('multi-select fzf returns every chosen candidate', () => {
  const cands = [cand('S1'), cand('S2'), cand('S3')]
  let args: string[] = []
  const exec: Exec = (_cmd, a, input) => {
    args = a
    const lines = (input ?? '').split('\n')
    return { status: 0, stdout: `${lines[0]}\n${lines[2]}\n`, stderr: '' }
  }
  assert.deepEqual(pickMany(cands, exec, { hasFzf: true, prompt: () => '' }).map(c => c.digest.sessionId), ['S1', 'S3'])
  assert.ok(args.includes('--multi'))
})

test('multi-select fzf escape chooses nothing', () => {
  const exec: Exec = () => ({ status: 130, stdout: '', stderr: '' })
  assert.deepEqual(pickMany([cand('S1')], exec, { hasFzf: true, prompt: () => '' }), [])
})

test('numbered multi-select takes a list, all, or nothing', () => {
  const cands = [cand('S1'), cand('S2'), cand('S3')]
  const exec: Exec = () => { throw new Error('no exec expected') }
  const ids = (answer: string) => pickMany(cands, exec, { hasFzf: false, prompt: () => answer }).map(c => c.digest.sessionId)
  assert.deepEqual(ids('1,3'), ['S1', 'S3'])
  assert.deepEqual(ids(' 2 3 '), ['S2', 'S3'])
  assert.deepEqual(ids('all'), ['S1', 'S2', 'S3'])
  assert.deepEqual(ids(''), [])
})

test('numbered multi-select rejects a number out of range or a word it does not know', () => {
  const cands = [cand('S1'), cand('S2')]
  const exec: Exec = () => { throw new Error('no exec expected') }
  assert.throws(() => pickMany(cands, exec, { hasFzf: false, prompt: () => '1,9' }), /invalid choice "1,9".*1-2/)
  assert.throws(() => pickMany(cands, exec, { hasFzf: false, prompt: () => '1,x' }), /invalid choice/)
})

test('numbered multi-select chooses a session once even when its number repeats', () => {
  const cands = [cand('S1'), cand('S2')]
  const exec: Exec = () => { throw new Error('no exec expected') }
  assert.deepEqual(pickMany(cands, exec, { hasFzf: false, prompt: () => '2,1,2' }).map(c => c.digest.sessionId), ['S2', 'S1'])
})

test('multi-select can start with every row marked and show a summary per row', () => {
  let args: string[] = []
  let input = ''
  const exec: Exec = (_cmd, a, i) => { args = a; input = i ?? ''; return { status: 130, stdout: '', stderr: '' } }
  pickMany([cand('S1')], exec, { hasFzf: true, prompt: () => '' }, { preselect: true, summaries: new Map([['S1', 'fixing envoy']]) })
  assert.ok(args.join(' ').includes('--bind load:select-all'), args.join(' '))
  assert.match(input, /fixing envoy/)
  pickMany([cand('S1')], exec, { hasFzf: true, prompt: () => '' })
  assert.ok(!args.join(' ').includes('select-all'))
})

test('multi-select fzf ignores Enter and double-click until a row is marked', () => {
  let args: string[] = []
  const exec: Exec = (_cmd, a) => { args = a; return { status: 130, stdout: '', stderr: '' } }
  pickMany([cand('S1')], exec, { hasFzf: true, prompt: () => '' })
  const binds = args.flatMap((a, i) => args[i - 1] === '--bind' ? [a] : [])
  for (const key of ['enter', 'double-click']) {
    assert.ok(binds.includes(`${key}:transform:[ "\${FZF_SELECT_COUNT:-0}" -gt 0 ] && echo accept`), binds.join(' | '))
  }
  assert.equal(args[args.indexOf('--header') + 1], 'Tab marks a session, Enter sends to the marked ones')
})
