import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * The uninstall case, tested the only way it can be: copy the entry file somewhere with no
 * node_modules, so dsh-mnemon/* cannot resolve, and import it. A static SDK import here would fail
 * exactly the way it would in a profile whose memory plugin was removed.
 */
test('the entry loads without dsh-mnemon installed, and waits for its service', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-source-absent-'))
  try {
    const copy = path.join(dir, 'index.js')
    await copyFile(path.join(root, 'lib', 'index.js'), copy)
    const script = [
      'const m = await import(' + JSON.stringify(pathToFileURL(copy).href) + ')',
      'const warnings = []',
      'const ctx = { logger: { warn: (line) => warnings.push(line) } }',
      'let threw = null',
      // The host never calls apply without the service, but a half-finished uninstall can: it must
      // warn once and return, not throw.
      'try { await m.apply(ctx, {}) } catch (error) { threw = String(error) }',
      'console.log(JSON.stringify({',
      '  name: m.name,',
      '  inject: m.inject,',
      '  apply: typeof m.apply,',
      '  descriptor: m.memoryPlugin,',
      '  threw,',
      '  warnings,',
      '}))',
    ].join('\n')
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000 })
    const seen = JSON.parse(stdout)
    assert.equal(seen.name, 'dsh-mnemon-source-global-todo')
    assert.deepEqual(seen.inject, ['mnemonMemory'], 'without the service the host never calls apply')
    assert.equal(seen.apply, 'function')
    assert.equal(seen.descriptor.packageName, 'dsh-mnemon-source-global-todo')
    assert.deepEqual(seen.descriptor.roles, ['source'])
    assert.ok(seen.descriptor.label['zh-CN'] && seen.descriptor.description.en)
    assert.equal(seen.threw, null, 'a missing memory plugin must not throw: ' + String(seen.threw))
    assert.equal(seen.warnings.length, 1, 'one warning explains the half-uninstalled state')
    assert.match(seen.warnings[0], /dsh-mnemon-source-global-todo/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
