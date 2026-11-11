import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RESUME_PROMPT, DEFAULT_STOP_PROMPT, loadConfig } from '../src/config.ts'
import { fixture } from './helpers.ts'

const configFile = (body: unknown) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ct-cfg-')), 'config.json')
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

test('defaults match the existing prompt files byte for byte', () => {
  assert.equal(DEFAULT_STOP_PROMPT, readFileSync(fixture('stop.txt'), 'utf8'))
  assert.equal(DEFAULT_RESUME_PROMPT, readFileSync(fixture('resume.txt'), 'utf8'))
})

test('missing file gives defaults', () =>
  assert.deepEqual(loadConfig('/nope/config.json'), {
    resumeCommand: undefined, stopPrompt: DEFAULT_STOP_PROMPT, resumePrompt: DEFAULT_RESUME_PROMPT, pauseTimeoutMinutes: 10, excludeDirs: []
  }))

test('every key can be overridden', () =>
  assert.deepEqual(loadConfig(configFile({ resumeCommand: 'c {id}', stopPrompt: 's', resumePrompt: 'r', pauseTimeoutMinutes: 3, excludeDirs: ['/ct-test-missing'] })),
    { resumeCommand: 'c {id}', stopPrompt: 's', resumePrompt: 'r', pauseTimeoutMinutes: 3, excludeDirs: ['/ct-test-missing'] }))

test('excludeDirs expands ~ and drops trailing slashes', () =>
  // Paths that can't exist, so realpath adds nothing whatever the host's symlinks are.
  assert.deepEqual(loadConfig(configFile({ excludeDirs: ['~/.ct-test-missing/observer-sessions/', '/ct-test-missing/scratch//'] })).excludeDirs,
    [join(homedir(), '.ct-test-missing', 'observer-sessions'), '/ct-test-missing/scratch']))

test('bad values throw naming the key', () => {
  assert.throws(() => loadConfig(configFile({ pauseTimeoutMinutes: 0 })), /pauseTimeoutMinutes/)
  assert.throws(() => loadConfig(configFile({ stopPrompt: '' })), /stopPrompt/)
  assert.throws(() => loadConfig(configFile({ resumePrompt: 5 })), /resumePrompt/)
  assert.throws(() => loadConfig(configFile({ resumeCommand: 1 })), /resumeCommand/)
  assert.throws(() => loadConfig(configFile({ excludeDirs: '/x' })), /excludeDirs/)
  assert.throws(() => loadConfig(configFile({ excludeDirs: ['relative/dir'] })), /excludeDirs/)
  assert.throws(() => loadConfig(configFile({ excludeDirs: [''] })), /excludeDirs/)
})

test('an excluded dir reached through a symlink also matches its real path', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ct-cfg-link-')))
  mkdirSync(join(root, 'real'))
  symlinkSync(join(root, 'real'), join(root, 'link'))
  assert.deepEqual(loadConfig(configFile({ excludeDirs: [join(root, 'link')] })).excludeDirs, [join(root, 'link'), join(root, 'real')])
})

test('invalid JSON throws naming the path', () => {
  const file = configFile('{nope')
  assert.throws(() => loadConfig(file), new RegExp(file.replaceAll('/', '\\/')))
})
