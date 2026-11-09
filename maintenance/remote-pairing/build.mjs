#!/usr/bin/env node
/** Isolated source build of bridge HOST AND CLIENT. No installation or restart. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = realpathSync(dirname(fileURLToPath(import.meta.url)))
const repo = resolve(here, '../..')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const release = json(join(here, 'release.json'))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node maintenance/remote-pairing/build.mjs [--dsh-root <installed official SDK>] [--allow-dirty]\nNode >=24.11; npm ci --prefix maintenance/remote-pairing/tools --ignore-scripts first. Builds one bridge tgz, not the other two maintenance packages. Never installs or restarts.')
  process.exit(0)
}
for (let i = 0; i < args.length; i++) {
  assert(['--dsh-root', '--allow-dirty'].includes(args[i]), 'Unknown argument')
  if (args[i] === '--dsh-root') { assert(args[i + 1] && !args[i + 1].startsWith('--')); i++ }
}
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
function run(exe, args, cwd, nodeEnv = 'test') {
  console.log(`> ${exe} ${args.join(' ')}`)
  execFileSync(exe, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_ENV: nodeEnv, CI: 'true' } })
}
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'Source symlinks are not release inputs')
    const name = prefix + entry.name
    return entry.isDirectory() ? files(join(dir, entry.name), name + '/') : [name]
  }).sort()
}
function checkedDir(path) {
  const target = resolve(path)
  assert(target.startsWith(here + '/'), 'Output must stay inside maintenance directory')
  let current = here
  for (const part of relative(here, target).split('/')) {
    current = join(current, part)
    if (existsSync(current)) assert(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'Output path follows a symlink')
    else mkdirSync(current)
    assert.equal(realpathSync(current), current)
  }
  return target
}
const dirty = git('status', '--porcelain', '--untracked-files=all') !== ''
assert(!dirty || args.includes('--allow-dirty'), 'Commit source first; --allow-dirty is rehearsal only')
const sha = git('rev-parse', 'HEAD')
assert.equal(git('rev-parse', `${release.upstreamTag}^{commit}`), release.upstreamCommit)
git('merge-base', '--is-ancestor', release.upstreamCommit, 'HEAD')
assert.match(release.version, /^\d+\.\d+\.\d+-bja\.pairing\.\d+$/)
assert.equal(release.name, '@linxin666/dsh-remote-bridge')
assert.equal(release.directory, 'dsh-remote-bridge')
assert.equal(release.rowId, 'web-ui-remote-bridge')
assert.equal(json(join(repo, 'package.json')).version, release.upstreamTag.replace(/^v/, ''))
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
assert(nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 11), 'Node >=24.11 required')
const sdkIndex = args.indexOf('--dsh-root')
const dsh = realpathSync(sdkIndex >= 0 ? resolve(args[sdkIndex + 1]) : process.env.DSH_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai/dsh'))
assert.equal(json(join(dsh, 'package.json')).version, release.dshVersion)
assert.equal(json(join(dsh, 'package.json')).name, '@deepseek-ai/dsh')
const sdkRequire = createRequire(join(dsh, 'package.json'))
const sdkScope = dirname(dirname(sdkRequire.resolve('@deepseek-ai/dsh-client-connection/package.json')))
assert.equal(json(join(sdkScope, 'dsh-client-connection/package.json')).version, release.dshVersion)
const tools = join(here, 'tools/node_modules')
const tooling = json(join(here, 'tools/package.json')).dependencies
for (const [name, version] of Object.entries(tooling)) assert.equal(json(join(tools, name, 'package.json')).version, version, 'Locked build dependency drift: ' + name)
const work = mkdtempSync(join(checkedDir(join(here, '.work')), 'build-'))
const cache = checkedDir(join(here, 'cache'))
const dist = checkedDir(join(here, 'dist'))
const destination = resolve(dist, `${release.version}-${sha.slice(0, 8)}${dirty ? '-dirty-' + work.split('/').at(-1) : ''}`)
assert(destination.startsWith(dist + '/') && !existsSync(destination), 'Never overwrite an artifact directory')
const output = checkedDir(join(work, 'artifacts'))
const templatePath = join(cache, `dsh-remote-bridge-${release.templateVersion}.tgz`)
const [algorithm, integrity] = release.templateIntegrity.split('-')
assert.equal(algorithm, 'sha512'); assert(integrity)
const url = new URL(release.templateUrl)
assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'registry.npmjs.org')
if (!existsSync(templatePath)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  assert(response.ok, 'Template download failed')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(hash(bytes, algorithm, 'base64'), integrity)
  writeFileSync(templatePath, bytes)
}
assert.equal(hash(readFileSync(templatePath), algorithm, 'base64'), integrity)
for (const name of execFileSync('tar', ['-tzf', templatePath], { encoding: 'utf8' }).trim().split('\n')) {
  assert(name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\'), 'Unsafe template path')
}
for (const entry of execFileSync('tar', ['-tvzf', templatePath], { encoding: 'utf8' }).trim().split('\n')) assert(['-', 'd'].includes(entry[0]), 'Template links/special entries forbidden')
const stage = checkedDir(join(work, 'packages/dsh-remote-bridge'))
run('tar', ['-xzf', templatePath, '--strip-components=1', '--no-same-owner', '-C', stage], repo)
assert.equal(json(join(stage, 'package.json')).name, release.name)
const source = join(repo, 'packages/dsh-remote-bridge')
const sourceManifest = json(join(source, 'package.json'))
assert.equal(sourceManifest.version, release.templateVersion)
assert.equal(sourceManifest.name, release.name)
const treeHash = directory => hash(files(directory).map(name => name + '\0' + hash(readFileSync(join(directory, name)))).join('\n'))
for (const name of ['src', 'tests', 'locale', 'lib']) {
  const target = resolve(stage, name)
  assert(target.startsWith(stage + '/') && realpathSync(stage).startsWith(work + '/'))
  if (existsSync(target)) {
    assert.equal(realpathSync(target), target, 'Cleanup must not follow symlinks')
    console.log('Replace verified template tree:', target)
    rmSync(target, { recursive: true })
  }
  if (name !== 'lib') { files(join(source, name)); cpSync(join(source, name), target, { recursive: true }) }
}
cpSync(join(repo, 'shared'), join(work, 'shared'), { recursive: true })
files(join(repo, 'shared'))
for (const name of ['tsconfig.json', 'tsconfig.build.json', 'tsconfig.test.json', 'vitest.config.ts']) cpSync(join(source, name), join(stage, name))
const nm = join(stage, 'node_modules'); mkdirSync(nm)
for (const entry of readdirSync(tools)) {
  if (entry === '@deepseek-ai') continue
  symlinkSync(join(tools, entry), join(nm, entry), 'dir')
}
// DSH's production install contains Host SDK packages; browser SDK declaration
// packages are separately published and pinned in the isolated tools lock.
const scope = join(nm, '@deepseek-ai'); mkdirSync(scope)
for (const entry of readdirSync(sdkScope)) symlinkSync(join(sdkScope, entry), join(scope, entry), 'dir')
for (const entry of readdirSync(join(tools, '@deepseek-ai'))) {
  if (!existsSync(join(scope, entry))) symlinkSync(join(tools, '@deepseek-ai', entry), join(scope, entry), 'dir')
}
symlinkSync(tools, join(work, 'node_modules'), 'dir')
// Shared build preset needs its module resolution alongside the work root.
const packed = { ...sourceManifest, version: release.version, repository: { type: 'git', url: 'https://github.com/BeiJiaan/dsh-web.git', directory: 'packages/dsh-remote-bridge' }, scripts: { build: 'echo "Use maintenance/remote-pairing/build.mjs from the fork"' }, files: ['lib/**/*.js', 'lib/**/*.js.map', 'lib/**/*.d.ts', 'src', 'tests', 'cordis.patch.yml', 'icon.svg', 'locale', 'BJA-BUILD.json'] }
delete packed.devDependencies
for (const dependency of Object.keys(packed.dependencies)) { assert(tooling[dependency], 'Runtime dependency must be pinned'); packed.dependencies[dependency] = tooling[dependency] }
writeJson(join(stage, 'package.json'), packed)
writeFileSync(join(stage, 'cordis.patch.yml'), `# Override the existing aggregate row, never duplicate bridge instances.\n- id: ${release.rowId}\n  name: '${release.name}'\n`)
writeFileSync(join(stage, 'tsdown.release.config.ts'), `import { clientBundle } from '../../shared/tsdown.client.ts'\nexport default clientBundle('${release.name}', ['src/index.ts'], { libExternal: [/^@deepseek-ai\\//] })\n`)
run(process.execPath, [join(tools, 'vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', '--maxWorkers=4'], stage)
run(process.execPath, [join(tools, 'typescript/bin/tsc'), '-p', 'tsconfig.test.json', '--pretty', 'false'], stage)
run(process.execPath, [join(tools, 'typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--pretty', 'false'], stage)
run(process.execPath, [join(tools, 'tsdown/dist/run.mjs'), '--config', 'tsdown.release.config.ts'], stage, 'production')
const client = readFileSync(join(stage, 'lib/client.js'))
assert(client.toString().includes('window.__ModuleLoader__.load'), 'Browser artifact must use the supported DSH module loader')
assert(client.toString().includes('remote-token'), 'Browser artifact is missing remote pairing source')
run(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; const p = await import('./lib/index.js'); assert.equal(typeof p.apply, 'function'); const c = p.resolveBridgeConfig({}); assert.equal(c.remotePairingEnabled, false); assert.deepEqual(c.trustedPairingOrigins, []);`], stage)
const provenance = { version: release.version, sourceCommit: sha, dirty, upstreamCommit: release.upstreamCommit, dshVersion: release.dshVersion, templateUrl: release.templateUrl, templateIntegrity: release.templateIntegrity, toolLockSha256: hash(readFileSync(join(here, 'tools/package-lock.json'))), sourceTreeSha256: treeHash(join(source, 'src')), localeTreeSha256: treeHash(join(source, 'locale')), sharedBuildSha256: treeHash(join(repo, 'shared')), hostSha256: hash(readFileSync(join(stage, 'lib/index.js'))), browserSha256: hash(client), buildMode: 'full-host-and-client', tests: 'all bridge node and jsdom suites; source and test typechecks' }
writeJson(join(stage, 'BJA-BUILD.json'), provenance)
const packageInfo = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8' }))[0]
assert.equal(packageInfo.name, release.name); assert.equal(packageInfo.version, release.version)
assert.match(packageInfo.filename, /^[a-zA-Z0-9._-]+\.tgz$/)
const rootFiles = new Set(['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE', 'BJA-BUILD.json'])
for (const { path } of packageInfo.files) {
  assert(!path.split('/').includes('..') && (rootFiles.has(path) || ['lib/', 'src/', 'tests/', 'locale/'].some(prefix => path.startsWith(prefix))), 'Unexpected package file: ' + path)
  assert(!path.split('/').some(part => ['node_modules', '.npmrc', '.env'].includes(part)), 'Private/dependency files cannot ship')
}
const bytes = readFileSync(join(output, packageInfo.filename))
writeJson(join(output, 'manifest.json'), { ...provenance, gitCommit: sha, name: release.name, rowId: release.rowId, filename: packageInfo.filename, bytes: bytes.length, sha256: hash(bytes), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'), nodeVersion: process.versions.node, npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim() })
assert.equal(readdirSync(output).length, 2)
assert.equal(realpathSync(output), output)
assert(output.startsWith(work + '/') && destination.startsWith(dist + '/') && !existsSync(destination))
console.log('Promote complete verified artifact:', output, '->', destination)
renameSync(output, destination)
console.log(`\nVerified bridge release: ${relative(repo, destination)}\nNo profile was edited; no plugin installed; no service restarted.`)
