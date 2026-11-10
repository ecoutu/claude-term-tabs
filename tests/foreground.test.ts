import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foregroundKind } from '../src/foreground.ts'

const ps = (rows: Array<[number, number, string]>) => rows.map(([pgid, tpgid, comm]) => ` ${pgid} ${tpgid} ${comm}`).join('\n')

test('claude in the foreground group', () =>
  assert.equal(foregroundKind(ps([[10, 50, '-zsh'], [50, 50, '/opt/bin/claude'], [50, 50, 'node']])), 'claude'))

test('only a login shell in front', () =>
  assert.equal(foregroundKind(ps([[10, 10, '-zsh'], [20, 10, 'gitstatusd']])), 'shell'))

test('a wrapper or other program in front', () => {
  assert.equal(foregroundKind(ps([[10, 50, '-zsh'], [50, 50, 'caffeinate']])), 'other')
  assert.equal(foregroundKind(''), 'other')
})
