import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DigestCache } from '../src/cache.ts'
import type { Digest } from '../src/types.ts'

const digest = (title: string): Digest => ({ sessionId: 'S', cwd: '/x', repo: 'x', title, lastActive: 1 })

function setup () {
  const dir = mkdtempSync(join(tmpdir(), 'ctt-cache-'))
  const transcript = join(dir, 't.jsonl')
  writeFileSync(transcript, '{}\n')
  return { dir, transcript, cacheFile: join(dir, 'nested', 'digests.json') }
}

test('unchanged transcript is served from cache', () => {
  const { transcript, cacheFile } = setup()
  const cache = DigestCache.load(cacheFile, () => {})
  let calls = 0
  const extract = () => { calls++; return digest('a') }
  cache.get(transcript, extract)
  assert.equal(cache.get(transcript, extract).title, 'a')
  assert.equal(calls, 1)
})

test('new mtime re-extracts', () => {
  const { transcript, cacheFile } = setup()
  const cache = DigestCache.load(cacheFile, () => {})
  cache.get(transcript, () => digest('a'))
  utimesSync(transcript, new Date(), new Date(Date.now() + 5000))
  assert.equal(cache.get(transcript, () => digest('b')).title, 'b')
})

test('save then load round-trips and creates the directory', () => {
  const { transcript, cacheFile } = setup()
  const cache = DigestCache.load(cacheFile, () => {})
  cache.get(transcript, () => digest('a'))
  cache.save()
  const again = DigestCache.load(cacheFile, () => {})
  assert.equal(again.get(transcript, () => digest('b')).title, 'a')
  assert.deepEqual(readdirSync(join(cacheFile, '..')), ['digests.json'])
})

test('corrupt cache warns once and rebuilds', () => {
  const { dir, transcript } = setup()
  const cacheFile = join(dir, 'bad.json')
  writeFileSync(cacheFile, '{not json')
  const warnings: string[] = []
  const cache = DigestCache.load(cacheFile, m => warnings.push(m))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /rebuilding/)
  assert.equal(cache.get(transcript, () => digest('a')).title, 'a')
})

test('missing transcript bypasses the cache', () => {
  const { dir, cacheFile } = setup()
  const cache = DigestCache.load(cacheFile, () => {})
  let calls = 0
  const extract = () => { calls++; return digest('a') }
  cache.get(join(dir, 'gone.jsonl'), extract)
  cache.get(join(dir, 'gone.jsonl'), extract)
  assert.equal(calls, 2)
  cache.save()
  assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')).entries, {})
})

test('cache file and new directory are owner-only', () => {
  const { transcript, cacheFile } = setup()
  const cache = DigestCache.load(cacheFile, () => {})
  cache.get(transcript, () => digest('a'))
  cache.save()
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600)
  assert.equal(statSync(join(cacheFile, '..')).mode & 0o777, 0o700)
})

test('an existing loose cache directory is tightened to owner-only', () => {
  const { dir, transcript } = setup()
  const cacheDir = join(dir, 'loose')
  mkdirSync(cacheDir, { mode: 0o755 })
  const cacheFile = join(cacheDir, 'digests.json')
  const cache = DigestCache.load(cacheFile, () => {})
  cache.get(transcript, () => digest('a'))
  cache.save()
  assert.equal(statSync(cacheDir).mode & 0o777, 0o700)
})

test('retainOnly drops entries for transcripts no longer listed', () => {
  const { dir, transcript, cacheFile } = setup()
  const other = join(dir, 'other.jsonl')
  writeFileSync(other, '{}\n')
  const cache = DigestCache.load(cacheFile, () => {})
  cache.get(transcript, () => digest('a'))
  cache.get(other, () => digest('b'))
  cache.retainOnly(new Set([transcript]))
  cache.save()
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).entries), [transcript])
})
