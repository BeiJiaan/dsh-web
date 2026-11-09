#!/usr/bin/env node
/** Read-only artifact verification before a human-authorized installation. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

assert(process.argv.length === 3, 'Usage: node maintenance/owner-access/verify.mjs <artifact-directory>')
const directory = realpathSync(process.argv[2])
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
assert.equal(manifest.dirty, false, 'Dirty rehearsal artifacts must not be installed')
assert.match(manifest.gitCommit, /^[0-9a-f]{40}$/)
assert.equal(manifest.artifacts.length, 2)
assert.deepEqual(manifest.artifacts.map(a => a.name).sort(), ['@linxin666/dsh-session-archive', '@linxin666/dsh-usage'])
assert.equal(readdirSync(directory).length, 3, 'Expected exactly two tgz files and manifest.json')
const rows = { '@linxin666/dsh-session-archive': 'web-ui-session-archive', '@linxin666/dsh-usage': 'web-ui-usage' }
for (const artifact of manifest.artifacts) {
  assert.match(artifact.filename, /^[a-zA-Z0-9._-]+\.tgz$/)
  const path = join(directory, artifact.filename)
  const bytes = readFileSync(path)
  assert.equal(bytes.length, artifact.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, 'SHA-256 mismatch')
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), artifact.integrity, 'SHA-512 mismatch')
  const readMember = member => execFileSync('tar', ['-xOzf', path, 'package/' + member], { encoding: 'utf8' })
  const pkg = JSON.parse(readMember('package.json'))
  const provenance = JSON.parse(readMember('BJA-BUILD.json'))
  assert.equal(pkg.name, artifact.name)
  assert.equal(pkg.version, manifest.version)
  assert.equal(provenance.sourceCommit, manifest.gitCommit)
  assert.equal(provenance.dirty, false)
  assert.equal(provenance.upstreamCommit, manifest.upstreamCommit)
  assert.equal(provenance.dshVersion, manifest.dshVersion)
  assert.equal(provenance.browserSha256, artifact.browserSha256)
  const browser = execFileSync('tar', ['-xOzf', path, 'package/lib/client.js'])
  assert.equal(createHash('sha256').update(browser).digest('hex'), provenance.browserSha256)
  assert.equal(readMember('cordis.patch.yml'), `# Override existing dsh-web-all row; never duplicate schedulers.\n- id: ${rows[pkg.name]}\n  name: '${pkg.name}'\n`)
  console.log(`OK ${artifact.filename} (${manifest.gitCommit.slice(0, 8)})`)
}
console.log('Both packages verified. This command did not install anything or restart services.')
