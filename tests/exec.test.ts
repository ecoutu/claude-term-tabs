import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realExec } from '../src/exec.ts'

test('under npm test the real exec refuses to run anything', () => {
  assert.equal(process.env.CT_NO_REAL_EXEC, '1')
  const r = realExec('echo', ['hi'])
  assert.equal(r.status, 126)
  assert.match(r.stderr, /CT_NO_REAL_EXEC/)
})
