import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkForUpdates, type UpdateCheckDeps } from '../../src/update-check.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0)

function fakeDeps(over: Partial<UpdateCheckDeps> = {}) {
  const calls = { pidea: 0, pi: 0 }
  const deps: UpdateCheckDeps = {
    cachePath: join(mkdtempSync(join(tmpdir(), 'pidea-update-check-')), 'update-check.json'),
    now: () => NOW,
    installedPidea: '0.1.0',
    installedPi: async () => '1.5.0',
    latestPidea: async () => {
      calls.pidea++
      return '0.1.0'
    },
    latestPi: async () => {
      calls.pi++
      return '1.5.0'
    },
    timeoutMs: 1000,
    ...over
  }
  return { deps, calls }
}

test('a newer pidea release produces the pidea update notice', async () => {
  const { deps } = fakeDeps({ latestPidea: async () => '0.2.0' })
  assert.deepEqual(await checkForUpdates(deps), [
    'pidea 0.2.0 is available (you have 0.1.0). Run `pidea update` in a terminal.'
  ])
})

test('an outdated pi produces the pi update notice; nothing when both are current', async () => {
  const { deps } = fakeDeps({ installedPi: async () => '1.0.0' })
  assert.deepEqual(await checkForUpdates(deps), [
    'New version available: v1.5.0 (installed v1.0.0). Run: `npm i -g @earendil-works/pi-coding-agent`'
  ])
  assert.deepEqual(await checkForUpdates(fakeDeps().deps), [])
})

test('a check within 24 hours reuses the cached latest versions without lookups', async () => {
  const { deps, calls } = fakeDeps({ latestPidea: async () => '0.2.0' })
  await checkForUpdates(deps)
  assert.ok(existsSync(deps.cachePath))

  const later = fakeDeps({ cachePath: deps.cachePath, now: () => NOW + DAY - 1 })
  assert.deepEqual(await checkForUpdates(later.deps), [
    'pidea 0.2.0 is available (you have 0.1.0). Run `pidea update` in a terminal.'
  ])
  assert.deepEqual(later.calls, { pidea: 0, pi: 0 })
  assert.equal(calls.pi, 1)
})

test('a cache older than 24 hours is refreshed from the lookups', async () => {
  const { deps } = fakeDeps()
  writeFileSync(deps.cachePath, JSON.stringify({ checkedAt: NOW - DAY, pidea: '0.0.9', pi: '1.0.0' }))
  const fresh = fakeDeps({ cachePath: deps.cachePath, latestPidea: async () => '0.3.0' })
  assert.deepEqual(await checkForUpdates(fresh.deps), [
    'pidea 0.3.0 is available (you have 0.1.0). Run `pidea update` in a terminal.'
  ])
  assert.deepEqual(JSON.parse(readFileSync(deps.cachePath, 'utf8')), { checkedAt: NOW, pidea: '0.3.0', pi: '1.5.0' })
})

test('hanging or failing lookups give no notice within the timeout and cache nothing', async t => {
  const { deps } = fakeDeps({
    latestPidea: () => new Promise<string>(() => {}),
    latestPi: async () => {
      throw new Error('npm view failed')
    },
    timeoutMs: 50
  })
  // checkForUpdates unrefs its timeout so it never keeps pidea alive. With the lookup hanging,
  // nothing else would keep this test's event loop alive, and node:test would cancel the test.
  const keepAlive = setTimeout(() => {}, 5000)
  t.after(() => clearTimeout(keepAlive))
  const started = Date.now()
  assert.deepEqual(await checkForUpdates(deps), [])
  assert.ok(Date.now() - started < 1000)
  assert.equal(existsSync(deps.cachePath), false)
})
