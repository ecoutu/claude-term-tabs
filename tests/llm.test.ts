import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askHaiku, askHaikuForEvery, buildHaikuArgs, parseHaikuRanking, MAX_LLM_CANDIDATES } from '../src/llm.ts'
import type { Candidate, Exec } from '../src/types.ts'

const cand = (id: string, title: string): Candidate => ({
  live: true,
  status: 'idle',
  digest: { sessionId: id, cwd: '/x/api-orders', repo: 'api-orders', branch: 'main', title, lastPrompt: 'check\nit', lastActive: 1 }
})
const many = Array.from({ length: 20 }, (_, i) => cand(`id${i}`, `title ${i}`))

test('args keep the call minimal and unsaved', () => {
  const { args } = buildHaikuArgs('csv', many)
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--json-schema', '--system-prompt']) {
    assert.ok(args.includes(flag), flag)
  }
  const after = (f: string) => args[args.indexOf(f) + 1]
  assert.equal(after('--model'), 'haiku')
  assert.equal(after('--tools'), '')
  assert.equal(after('--setting-sources'), '')
  assert.equal(after('--output-format'), 'json')
})

test('input holds at most 15 one-line digests and the query', () => {
  const { input } = buildHaikuArgs('csv ingestion', many)
  const lines = input.split('\n').filter(l => l.startsWith('id'))
  assert.equal(MAX_LLM_CANDIDATES, 15)
  assert.equal(lines.length, 15)
  assert.equal(lines[0], 'id0 | api-orders | main | title 0 | check it')
  assert.match(input, /csv ingestion/)
})

const envelope = (matches: unknown) => JSON.stringify({ type: 'result', structured_output: { matches } })

test('parse keeps known ids in order and drops unknown ones', () => {
  const out = envelope([{ sessionId: 'id2', summary: 'b' }, { sessionId: 'nope', summary: 'x' }, { sessionId: 'id1', summary: 'a' }])
  assert.deepEqual(parseHaikuRanking(out, new Set(['id1', 'id2'])), [{ sessionId: 'id2', summary: 'b' }, { sessionId: 'id1', summary: 'a' }])
})

test('parse falls back to a JSON result string', () => {
  const out = JSON.stringify({ type: 'result', result: '```json\n{"matches":[{"sessionId":"id1","summary":"a"}]}\n```' })
  assert.deepEqual(parseHaikuRanking(out, new Set(['id1'])), [{ sessionId: 'id1', summary: 'a' }])
})

test('parse throws on non-JSON', () =>
  assert.throws(() => parseHaikuRanking('oops', new Set()), /JSON/))

test('askHaiku warns and returns undefined when claude is missing', () => {
  const exec: Exec = () => ({ status: 127, stdout: '', stderr: 'claude: spawn claude ENOENT' })
  const warnings: string[] = []
  assert.equal(askHaiku('q', many, exec, m => warnings.push(m)), undefined)
  assert.match(warnings[0], /claude not found, using local ranking/)
})

test('askHaiku warns and returns undefined on a failed call', () => {
  const exec: Exec = () => ({ status: 1, stdout: '', stderr: 'not logged in' })
  const warnings: string[] = []
  assert.equal(askHaiku('q', many, exec, m => warnings.push(m)), undefined)
  assert.match(warnings[0], /not logged in/)
})

test('askHaiku returns parsed ranking', () => {
  const exec: Exec = () => ({ status: 0, stdout: envelope([{ sessionId: 'id3', summary: 's' }]), stderr: '' })
  assert.deepEqual(askHaiku('q', many, exec, () => {}), [{ sessionId: 'id3', summary: 's' }])
})

test('askHaiku sets a timeout and treats a timeout as a failed call', () => {
  let timeout: number | undefined
  const exec: Exec = (_c, _a, _i, opts) => { timeout = opts?.timeoutMs; return { status: 124, stdout: '', stderr: 'claude: timed out' } }
  const warnings: string[] = []
  assert.equal(askHaiku('q', many, exec, m => warnings.push(m)), undefined)
  assert.ok(timeout !== undefined && timeout > 0 && timeout <= 30_000)
  assert.match(warnings[0], /timed out/)
})

test('parse throws when every returned id is unknown', () =>
  assert.throws(() => parseHaikuRanking(envelope([{ sessionId: 'nope', summary: 'x' }]), new Set(['id1'])), /unknown/))

test('askHaikuForEvery asks about every candidate, 15 at a time, for all that apply', () => {
  const inputs: string[] = []
  const prompts: string[] = []
  const exec: Exec = (_cmd, args, input) => {
    inputs.push(input ?? '')
    prompts.push(args[args.indexOf('--system-prompt') + 1])
    const ids = (input ?? '').split('\n').filter(l => l.startsWith('id')).map(l => l.split(' | ')[0])
    return { status: 0, stdout: envelope(ids.filter(id => id === 'id3' || id === 'id18').map(sessionId => ({ sessionId, summary: sessionId }))), stderr: '' }
  }
  const matches = askHaikuForEvery('csv', many, exec, () => {})
  assert.deepEqual(matches?.map(m => m.sessionId), ['id3', 'id18'])
  assert.deepEqual(inputs.map(i => i.split('\n').filter(l => l.startsWith('id')).length), [15, 5])
  assert.ok(prompts.every(p => /every session/i.test(p)), prompts[0])
})

test('askHaikuForEvery returns undefined when any batch fails', () => {
  let calls = 0
  const exec: Exec = () => (++calls === 2 ? { status: 1, stdout: '', stderr: 'quota' } : { status: 0, stdout: envelope([]), stderr: '' })
  const warnings: string[] = []
  assert.equal(askHaikuForEvery('q', many, exec, m => warnings.push(m)), undefined)
  assert.match(warnings.join('\n'), /quota/)
})

test('parse lists a session once even when Haiku repeats it', () => {
  const out = envelope([{ sessionId: 'id1', summary: 'a' }, { sessionId: 'id2', summary: 'b' }, { sessionId: 'id1', summary: 'again' }])
  assert.deepEqual(parseHaikuRanking(out, new Set(['id1', 'id2'])), [{ sessionId: 'id1', summary: 'a' }, { sessionId: 'id2', summary: 'b' }])
})
