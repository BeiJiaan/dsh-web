#!/usr/bin/env node
/** Source-controlled host-only releases. Never writes profiles, installs plugins,
 * restarts services, publishes npm packages, or changes the working Git branch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = realpathSync(dirname(fileURLToPath(import.meta.url)))
const repo = resolve(here, '../..')
const release = JSON.parse(readFileSync(join(here, 'release.json'), 'utf8'))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node maintenance/owner-access/build.mjs [--dsh-root <installed DSH directory>] [--allow-dirty]\nRequires Node >=24.11 and npm ci --prefix maintenance/owner-access/tools --ignore-scripts. Does not install or restart DSH.')
  process.exit(0)
}
for (let i = 0; i < args.length; i++) {
  assert(['--dsh-root', '--allow-dirty'].includes(args[i]), `Unknown argument ${args[i]}`)
  if (args[i] === '--dsh-root') { assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing --dsh-root value'); i++ }
}
function git(...args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim() }
function run(exe, args, cwd) {
  console.log(`> ${exe} ${args.join(' ')}`)
  execFileSync(exe, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', CI: 'true' } })
}
function json(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
function hash(bytes, algorithm = 'sha256', encoding = 'hex') { return createHash(algorithm).update(bytes).digest(encoding) }
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), `Unexpected source symlink ${join(dir, entry.name)}`)
    const name = prefix + entry.name
    return entry.isDirectory() ? files(join(dir, entry.name), name + '/') : [name]
  }).sort()
}
function checkedDir(path) {
  const result = resolve(path)
  assert(result.startsWith(here + '/'), 'Build output must stay inside maintenance directory')
  let current = here
  for (const component of relative(here, result).split('/')) {
    current = join(current, component)
    if (existsSync(current)) {
      const stats = lstatSync(current)
      assert(stats.isDirectory() && !stats.isSymbolicLink(), `Build path must not follow symlinks: ${current}`)
    } else mkdirSync(current)
    assert.equal(realpathSync(current), current, 'Physical build path escaped maintenance directory')
  }
  return result
}
function discardTemplateTree(stage, suffix) {
  assert(['src', 'lib/types'].includes(suffix), 'Only reviewed template trees may be replaced')
  const target = resolve(stage, suffix)
  assert(realpathSync(stage).startsWith(work + '/') && target.startsWith(stage + '/'), 'Template cleanup must stay in isolated work directory')
  if (existsSync(target)) {
    assert.equal(realpathSync(target), target, 'Template cleanup may not follow symlinks')
    console.log(`Replacing verified template tree: ${target}`)
    rmSync(target, { recursive: true })
  }
}
const dirty = git('status', '--porcelain', '--untracked-files=all') !== ''
assert(!dirty || args.includes('--allow-dirty'), 'Commit source changes first, or use --allow-dirty for a non-release rehearsal')
const sha = git('rev-parse', 'HEAD')
assert.equal(git('rev-parse', `${release.upstreamTag}^{commit}`), release.upstreamCommit, 'Upstream tag and reviewed SHA must agree')
git('merge-base', '--is-ancestor', release.upstreamCommit, 'HEAD')
assert.match(release.version, /^\d+\.\d+\.\d+-bja\.owner\.\d+$/)
assert.equal(json(join(repo, 'package.json')).version, release.upstreamTag.replace(/^v/, ''), 'Review release.json after upstream version changes')
const nodeMajor = Number(process.versions.node.split('.')[0])
assert(nodeMajor >= 24, 'Build tools require Node >=24.11')
if (nodeMajor === 24) assert(Number(process.versions.node.split('.')[1]) >= 11, 'Build tools require Node >=24.11')
const dshArg = args.indexOf('--dsh-root')
const dshRoot = realpathSync(dshArg >= 0 ? resolve(args[dshArg + 1]) : process.env.DSH_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai/dsh'))
assert.equal(json(join(dshRoot, 'package.json')).name, '@deepseek-ai/dsh')
assert.equal(json(join(dshRoot, 'package.json')).version, release.dshVersion, 'DSH SDK differs from reviewed release.json; review and test before changing the pin')
// npm global installs nest dependencies under DSH; local CI installs may hoist
// them beside DSH. Resolve the actual cohort rather than assuming either layout.
const sdkRequire = createRequire(join(dshRoot, 'package.json'))
const sdkScope = dirname(dirname(sdkRequire.resolve('@deepseek-ai/dsh-client-connection/package.json')))
assert.equal(json(join(sdkScope, 'dsh-client-connection/package.json')).version, release.dshVersion, 'Incomplete or mixed official SDK installation')
const tools = join(here, 'tools/node_modules')
assert(existsSync(join(tools, 'vitest/vitest.mjs')), 'Run npm ci --prefix maintenance/owner-access/tools --ignore-scripts first')
for (const [name, version] of Object.entries(json(join(here, 'tools/package.json')).dependencies)) {
  assert.equal(json(join(tools, name, 'package.json')).version, version, `Tool version drift: ${name}; run npm ci`)
}
const work = mkdtempSync(join(checkedDir(join(here, '.work')), 'build-'))
const cache = checkedDir(join(here, 'cache'))
const dist = checkedDir(join(here, 'dist'))
const destination = resolve(dist, `${release.version}-${sha.slice(0, 8)}${dirty ? '-dirty-' + work.split('/').at(-1) : ''}`)
assert(destination.startsWith(dist + '/') && !existsSync(destination), 'Release destination must be new and inside dist; never overwrite a release')
const output = checkedDir(join(work, 'artifacts'))
const artifacts = []
for (const item of release.packages) {
  assert.match(item.directory, /^dsh-[a-z-]+$/)
  assert.match(item.rowId, /^web-ui-[a-z-]+$/)
  assert.match(item.templateVersion, /^\d+\.\d+\.\d+$/)
  const source = join(repo, 'packages', item.directory)
  const sourceManifest = json(join(source, 'package.json'))
  assert.equal(sourceManifest.name, item.name)
  assert.equal(sourceManifest.version, item.templateVersion, 'Upstream package/template versions must match')
  const templatePath = join(cache, `${item.directory}-${item.templateVersion}.tgz`)
  const [algorithm, expected] = item.templateIntegrity.split('-')
  assert.equal(algorithm, 'sha512'); assert(expected)
  if (!existsSync(templatePath)) {
    const url = new URL(item.templateUrl)
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'registry.npmjs.org')
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    assert(response.ok, `Template download failed ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(hash(bytes, algorithm, 'base64'), expected, 'Downloaded template integrity mismatch')
    writeFileSync(templatePath, bytes)
  }
  const template = readFileSync(templatePath)
  assert.equal(hash(template, algorithm, 'base64'), expected, 'Cached template integrity mismatch')
  // Validate the pinned archive before extraction; reject link/special entries.
  const names = execFileSync('tar', ['-tzf', templatePath], { encoding: 'utf8' }).trim().split('\n')
  for (const name of names) assert(name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\'), 'Unsafe archive entry')
  const listing = execFileSync('tar', ['-tvzf', templatePath], { encoding: 'utf8' }).trim().split('\n')
  for (const line of listing) assert(['-', 'd'].includes(line[0]), 'Archive links and special files are not accepted')
  const stageRoot = checkedDir(join(work, item.directory))
  run('tar', ['-xzf', templatePath, '--no-same-owner', '-C', stageRoot], repo)
  const stage = join(stageRoot, 'package')
  assert.equal(json(join(stage, 'package.json')).name, item.name)
  const originalBrowser = hash(readFileSync(join(stage, 'lib/client.js')))
  // Host-only means every frontend source must match the reviewed official template.
  const officialClient = files(join(stage, 'src/client'))
  assert.deepEqual(files(join(source, 'src/client')), officialClient, 'Frontend files changed: update the release build strategy rather than reusing old client artifacts')
  for (const file of officialClient) assert(readFileSync(join(source, 'src/client', file)).equals(readFileSync(join(stage, 'src/client', file))), `Frontend source changed: ${file}`)
  // Also catch browser-shared core logic changes outside src/client. Only the
  // reviewed host-only patch files (including additive config types) may differ.
  const allowed = new Set(item.hostPatchFiles)
  for (const file of allowed) assert(file.startsWith('src/') && !file.startsWith('src/client/'), 'Host patch allowlist cannot include browser sources')
  const forkSources = files(join(source, 'src')).map(file => 'src/' + file)
  const templateSources = files(join(stage, 'src')).map(file => 'src/' + file)
  for (const file of new Set([...forkSources, ...templateSources])) {
    const a = join(source, file), b = join(stage, file)
    if (!allowed.has(file)) assert(existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b)), `Unreviewed shared/frontend source change: ${file}`)
  }
  files(join(source, 'tests')) // Refuse symlinked tests before copying.
  discardTemplateTree(stage, 'src')
  cpSync(join(source, 'src'), join(stage, 'src'), { recursive: true })
  const clientTypes = join(stageRoot, 'official-client-types')
  cpSync(join(stage, 'lib/types/client'), clientTypes, { recursive: true })
  discardTemplateTree(stage, 'lib/types')
  mkdirSync(join(stage, 'lib/types'), { recursive: true })
  cpSync(clientTypes, join(stage, 'lib/types/client'), { recursive: true })
  assert(!existsSync(join(stage, 'lib/index.js.map')), 'Template gained a host sourcemap; review host cleanup before releasing')
  cpSync(join(source, 'tests'), join(stage, 'tests'), { recursive: true })
  for (const test of item.tests) assert(existsSync(join(stage, 'tests', test + '.spec.ts')), `Missing reviewed test ${test}`)
  const nm = join(stage, 'node_modules'); mkdirSync(nm)
  for (const entry of readdirSync(tools)) {
    if (entry === '@deepseek-ai') continue
    symlinkSync(join(tools, entry), join(nm, entry), 'dir')
  }
  symlinkSync(sdkScope, join(nm, '@deepseek-ai'), 'dir')
  writeJson(join(stage, 'tsconfig.host.json'), { compilerOptions: { target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, allowImportingTsExtensions: true, declaration: true, emitDeclarationOnly: true, rootDir: 'src', outDir: 'lib/types', types: ['node'] }, files: ['src/index.ts'] })
  writeFileSync(join(stage, 'vitest.host.config.ts'), `import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { environment: 'node', include: ${JSON.stringify(item.tests.map(test => `tests/${test}.spec.ts`))} } })\n`)
  writeFileSync(join(stage, 'tsdown.host.config.ts'), `import { defineConfig } from 'tsdown'\nexport default defineConfig({ entry: ['src/index.ts'], format: 'esm', fixedExtension: false, platform: 'node', target: 'node24', outDir: 'lib', clean: false, dts: false, sourcemap: false, deps: { neverBundle: [/^@deepseek-ai\\//] } })\n`)
  run(process.execPath, [join(tools, 'vitest/vitest.mjs'), 'run', '--config', 'vitest.host.config.ts'], stage)
  run(process.execPath, [join(tools, 'typescript/bin/tsc'), '-p', 'tsconfig.host.json'], stage)
  run(process.execPath, [join(tools, 'tsdown/dist/run.mjs'), '--config', 'tsdown.host.config.ts'], stage)
  assert.equal(hash(readFileSync(join(stage, 'lib/client.js'))), originalBrowser, 'Host build changed browser artifact')
  const packed = { ...sourceManifest, version: release.version, repository: { type: 'git', url: 'https://github.com/BeiJiaan/dsh-web.git', directory: 'packages/' + item.directory }, scripts: { build: 'echo "Build from the fork maintenance tooling, not the installed package"' }, files: ['lib/**/*.js', 'lib/**/*.js.map', 'lib/**/*.d.ts', 'src', 'tests', 'cordis.patch.yml', 'icon.svg', 'locale', 'BJA-BUILD.json'] }
  delete packed.devDependencies
  writeJson(join(stage, 'package.json'), packed)
  writeFileSync(join(stage, 'cordis.patch.yml'), `# Override existing dsh-web-all row; never duplicate schedulers.\n- id: ${item.rowId}\n  name: '${item.name}'\n`)
  const provenance = { version: release.version, sourceCommit: sha, dirty, upstreamCommit: release.upstreamCommit, templateVersion: item.templateVersion, templateUrl: item.templateUrl, templateIntegrity: item.templateIntegrity, dshVersion: release.dshVersion, toolLockSha256: hash(readFileSync(join(here, 'tools/package-lock.json'))), browserSha256: originalBrowser, testedSuites: item.tests }
  writeJson(join(stage, 'BJA-BUILD.json'), provenance)
  run(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; const p = await import('./lib/index.js'); assert.equal(typeof p.apply, 'function'); const c = p.Config({}); const v = c.allowAuthenticatedRemote; assert.equal(typeof v?.get === 'function' ? v.get() : v, false);`], stage)
  const result = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8' })
  const packageInfo = JSON.parse(result)[0]
  const rootFiles = new Set(['package.json', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'BJA-BUILD.json'])
  for (const { path } of packageInfo.files) {
    assert(!path.split('/').includes('..') && (rootFiles.has(path) || ['lib/', 'src/', 'tests/', 'locale/'].some(prefix => path.startsWith(prefix))), `Unexpected release file: ${path}`)
    assert(!path.split('/').some(part => part === 'node_modules' || part === '.npmrc' || part === '.env'), 'Private/dependency files must not ship')
  }
  assert.match(packageInfo.filename, /^[a-zA-Z0-9._-]+\.tgz$/)
  const bytes = readFileSync(join(output, packageInfo.filename))
  artifacts.push({ name: item.name, filename: packageInfo.filename, bytes: bytes.length, sha256: hash(bytes), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'), ...provenance })
}
assert.equal(artifacts.length, 2, 'Release must contain both reviewed packages')
assert.equal(new Set(artifacts.map(item => item.filename)).size, 2)
writeJson(join(output, 'manifest.json'), { version: release.version, gitCommit: sha, dirty, upstreamTag: release.upstreamTag, upstreamCommit: release.upstreamCommit, dshVersion: release.dshVersion, nodeVersion: process.versions.node, npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), artifacts })
assert.equal(readdirSync(output).length, 3, 'No unexpected files may join a release')
// Promote only after BOTH packages pass; verified absolute paths cannot escape.
assert.equal(realpathSync(output), output)
assert(output.startsWith(work + '/') && destination.startsWith(dist + '/') && !existsSync(destination))
console.log(`Promoting verified release: ${output} -> ${destination}`)
renameSync(output, destination)
console.log(`\nVerified artifacts: ${relative(repo, destination)}\nNo production plugins were installed and no service was restarted.`)
