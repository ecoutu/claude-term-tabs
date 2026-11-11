import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const npm = (args: string[], cwd = root) => spawnSync('npm', args, { cwd, encoding: 'utf8' })

test('the npm package installs and runs both commands from node_modules', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ctt-pack-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pack = npm(['pack', '--json', '--pack-destination', dir])
  assert.equal(pack.status, 0, pack.stderr)
  const [{ filename, files }] = JSON.parse(pack.stdout) as [{ filename: string, files: Array<{ path: string }> }]
  const paths = files.map(f => f.path)
  assert.ok(paths.includes('dist/cli.js') && paths.includes('LICENSE'), paths.join(' '))
  assert.deepEqual(paths.filter(p => /^(src|tests|docs)\//.test(p)), [])

  const prefix = join(dir, 'prefix')
  const install = npm(['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(dir, filename)], dir)
  assert.equal(install.status, 0, install.stderr)
  const help = spawnSync(join(prefix, 'bin', 'claude-term-tabs'), ['--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^usage: ctt /)
  const complete = spawnSync(join(prefix, 'bin', 'ctt'), ['--complete', 'bash', 'ctt', 'pa'], { encoding: 'utf8' })
  assert.equal(complete.status, 0, complete.stderr)
  assert.equal(complete.stdout, 'pause\n')
  const script = spawnSync(join(prefix, 'bin', 'ctt'), ['completion', 'bash'], { encoding: 'utf8' })
  assert.equal(script.status, 0, script.stderr)
  assert.match(script.stdout, /'claude-term-tabs' --complete bash /)
})
