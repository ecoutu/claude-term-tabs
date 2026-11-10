import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    resumeCommand: undefined, stopPrompt: DEFAULT_STOP_PROMPT, resumePrompt: DEFAULT_RESUME_PROMPT, pauseTimeoutMinutes: 10
  }))

test('every key can be overridden', () =>
  assert.deepEqual(loadConfig(configFile({ resumeCommand: 'c {id}', stopPrompt: 's', resumePrompt: 'r', pauseTimeoutMinutes: 3 })),
    { resumeCommand: 'c {id}', stopPrompt: 's', resumePrompt: 'r', pauseTimeoutMinutes: 3 }))

test('bad values throw naming the key', () => {
  assert.throws(() => loadConfig(configFile({ pauseTimeoutMinutes: 0 })), /pauseTimeoutMinutes/)
  assert.throws(() => loadConfig(configFile({ stopPrompt: '' })), /stopPrompt/)
  assert.throws(() => loadConfig(configFile({ resumePrompt: 5 })), /resumePrompt/)
  assert.throws(() => loadConfig(configFile({ resumeCommand: 1 })), /resumeCommand/)
})

test('invalid JSON throws naming the path', () => {
  const file = configFile('{nope')
  assert.throws(() => loadConfig(file), new RegExp(file.replaceAll('/', '\\/')))
})
