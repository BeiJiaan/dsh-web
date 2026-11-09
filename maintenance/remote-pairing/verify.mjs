#!/usr/bin/env node
/** Verify trusted build artifacts; this does not establish trust in their source. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
assert.equal(process.argv.length, 3, 'Usage: node maintenance/remote-pairing/verify.mjs <artifact-directory>')
const directory = realpathSync(process.argv[2])
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
assert.equal(manifest.dirty, false, 'Never install dirty rehearsal artifacts')
assert.equal(manifest.name, '@linxin666/dsh-remote-bridge')
assert.equal(manifest.rowId, 'web-ui-remote-bridge')
assert.equal(manifest.buildMode, 'full-host-and-client')
assert.match(manifest.gitCommit, /^[a-f0-9]{40}$/)
assert.equal(manifest.sourceCommit, manifest.gitCommit)
assert.match(manifest.filename, /^[a-zA-Z0-9._-]+\.tgz$/)
assert.equal(readdirSync(directory).length, 2)
const file = join(directory, manifest.filename)
const bytes = readFileSync(file)
const hash = (b, alg = 'sha256', format = 'hex') => createHash(alg).update(b).digest(format)
assert.equal(bytes.length, manifest.bytes)
assert.equal(hash(bytes), manifest.sha256)
assert.equal('sha512-' + hash(bytes, 'sha512', 'base64'), manifest.integrity)
const readMember = name => execFileSync('tar', ['-xOzf', file, 'package/' + name])
const pkg = JSON.parse(readMember('package.json'))
const provenance = JSON.parse(readMember('BJA-BUILD.json'))
assert.equal(pkg.name, manifest.name); assert.equal(pkg.version, manifest.version)
assert.equal(pkg.repository.url, 'https://github.com/BeiJiaan/dsh-web.git')
for (const field of Object.keys(provenance)) assert.deepEqual(manifest[field], provenance[field], 'Provenance mismatch: ' + field)
assert.equal(hash(readMember('lib/index.js')), provenance.hostSha256)
assert.equal(hash(readMember('lib/client.js')), provenance.browserSha256)
assert.equal(readMember('cordis.patch.yml').toString(), `# Override the existing aggregate row, never duplicate bridge instances.\n- id: ${manifest.rowId}\n  name: '${manifest.name}'\n`)
assert(readMember('lib/client.js').toString().includes('window.__ModuleLoader__.load'))
console.log(`OK ${manifest.filename}; Host + browser verified; source ${manifest.gitCommit.slice(0, 8)}`)
console.log('No plugin installed and no service restarted.')
