import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchLatestRelease, installPrefix, runUpdate, type UpdateDeps } from '../../src/update.js'

const PREFIX = '/opt/u/.pi/pidea'
const TARBALL = 'https://github.com/JohannesKaminski/pidea/releases/download/v0.2.0/pidea-0.2.0.tgz'

function fakeDeps(over: Partial<UpdateDeps> = {}) {
  const output: string[] = []
  const installs: string[][] = []
  const deps: UpdateDeps = {
    installedVersion: '0.1.0',
    scriptPath: `${PREFIX}/lib/node_modules/pidea/dist/index.js`,
    platform: 'linux',
    latestRelease: async () => ({ version: '0.2.0', tarballUrl: TARBALL }),
    npmInstall: (url, prefix) => {
      installs.push([url, prefix])
      return { status: 0, stderr: '' }
    },
    out: s => output.push(s),
    ...over
  }
  return { deps, output: () => output.join(''), installs }
}

test('update --check reports a newer release without installing it', async () => {
  const f = fakeDeps()
  const code = await runUpdate(['--check'], f.deps)
  assert.equal(code, 0)
  assert.match(f.output(), /installed: 0\.1\.0/)
  assert.match(f.output(), /latest: {4}0\.2\.0/)
  assert.match(f.output(), /pidea 0\.2\.0 is available/)
  assert.deepEqual(f.installs, [])
})

test('update installs the newer release tarball into its own prefix and asks for an IDE restart', async () => {
  const f = fakeDeps()
  const code = await runUpdate([], f.deps)
  assert.equal(code, 0)
  assert.deepEqual(f.installs, [[TARBALL, PREFIX]])
  assert.match(f.output(), /Restart the IDE to use pidea 0\.2\.0/)
})

test('update does nothing when the installed version is the latest', async () => {
  const f = fakeDeps({ installedVersion: '0.2.0' })
  const code = await runUpdate([], f.deps)
  assert.equal(code, 0)
  assert.deepEqual(f.installs, [])
  assert.match(f.output(), /pidea is up to date/)
})

test('update refuses to install from the npx cache', async () => {
  const f = fakeDeps({ scriptPath: '/opt/u/.npm/_npx/abc/node_modules/pidea/dist/index.js' })
  const code = await runUpdate([], f.deps)
  assert.equal(code, 1)
  assert.deepEqual(f.installs, [])
  assert.match(f.output(), /npx cache/)
})

test('update refuses when pidea was not installed with npm', async () => {
  const f = fakeDeps({ scriptPath: '/work/pidea/dist/index.js' })
  const code = await runUpdate([], f.deps)
  assert.equal(code, 1)
  assert.deepEqual(f.installs, [])
  assert.match(f.output(), /was not installed with npm/)
})

test('installPrefix finds the npm prefix of an installed pidea', () => {
  assert.equal(installPrefix('/opt/u/.pi/pidea/lib/node_modules/pidea/dist/index.js', 'linux'), '/opt/u/.pi/pidea')
  assert.equal(installPrefix('/usr/local/lib/node_modules/pidea/dist/index.js', 'darwin'), '/usr/local')
  assert.equal(
    installPrefix('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pidea\\dist\\index.js', 'win32'),
    'C:\\Users\\u\\AppData\\Roaming\\npm'
  )
  assert.equal(installPrefix('/work/pidea/dist/index.js', 'linux'), null)
  assert.equal(installPrefix('/work/app/node_modules/pidea/dist/index.js', 'linux'), null)
})

test('update explains how to avoid sudo when npm fails with EACCES', async () => {
  const f = fakeDeps({
    npmInstall: () => ({ status: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir\n' })
  })
  const code = await runUpdate([], f.deps)
  assert.equal(code, 1)
  assert.match(f.output(), /may not write to \/opt\/u\/\.pi\/pidea/)
  assert.match(f.output(), /Don't use sudo/)
  assert.match(f.output(), /installer from the README/)
  assert.doesNotMatch(f.output(), /Restart the IDE/)
})

test('update reports a failed release lookup instead of crashing', async () => {
  const f = fakeDeps({
    latestRelease: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }
  })
  const code = await runUpdate(['--check'], f.deps)
  assert.equal(code, 1)
  assert.match(f.output(), /could not look up the latest release: getaddrinfo ENOTFOUND api\.github\.com/)
})

test('fetchLatestRelease reads the version and the tarball asset from GitHub', async () => {
  const urls: string[] = []
  const fakeFetch = (async (url: string) => {
    urls.push(url)
    return new Response(
      JSON.stringify({
        tag_name: 'v0.2.0',
        assets: [
          { name: 'notes.txt', browser_download_url: 'https://example.invalid/notes.txt' },
          { name: 'pidea-0.2.0.tgz', browser_download_url: TARBALL }
        ]
      }),
      { status: 200 }
    )
  }) as typeof fetch
  assert.deepEqual(await fetchLatestRelease(fakeFetch), { version: '0.2.0', tarballUrl: TARBALL })
  assert.deepEqual(urls, ['https://api.github.com/repos/JohannesKaminski/pidea/releases/latest'])
})

test('fetchLatestRelease fails on an error status or a release without a tarball', async () => {
  const notFound = (async () => new Response('{}', { status: 404 })) as typeof fetch
  await assert.rejects(fetchLatestRelease(notFound), /GitHub answered 404/)
  const noAsset = (async () =>
    new Response(JSON.stringify({ tag_name: 'v0.2.0', assets: [] }), { status: 200 })) as typeof fetch
  await assert.rejects(fetchLatestRelease(noAsset), /no \.tgz asset/)
})
