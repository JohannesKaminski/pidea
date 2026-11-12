import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEntry, isEphemeralInstall, mergeConfig, stableNodePath } from '../../src/setup.js'

const base = {
  nodePath: '/opt/node/bin/node',
  scriptPath: '/opt/u/lib/node_modules/pidea/dist/index.js',
  piPath: '/opt/pi/bin/pi',
  basePath: '/usr/bin:/opt/node/bin',
  platform: 'linux' as const
}

test('buildEntry uses absolute node + script and an explicit PATH', () => {
  const e = buildEntry(base) as any
  assert.equal(e.command, '/opt/node/bin/node')
  assert.deepEqual(e.args, [base.scriptPath])
  assert.equal(e.env.PIDEA_PI_COMMAND, '/opt/pi/bin/pi')
  assert.equal(e.env.PATH, '/opt/node/bin:/opt/pi/bin:/usr/bin')
})

test('mergeConfig keeps other agents, user keys, and the allow-list', () => {
  const existing = {
    default_mcp_settings: { use_idea_mcp: false },
    agent_servers: {
      other: { command: 'x' },
      pidea: { idea_mcp_allowed_tools: ['read_file'], env: { FOO: '1' }, command: 'old' }
    }
  }
  const m = mergeConfig(existing, 'pidea', buildEntry(base)) as any
  assert.equal(m.default_mcp_settings.use_idea_mcp, false)
  assert.equal(m.default_mcp_settings.use_custom_mcp, true)
  assert.deepEqual(m.agent_servers.other, { command: 'x' })
  assert.deepEqual(m.agent_servers['pidea'].idea_mcp_allowed_tools, ['read_file'])
  assert.equal(m.agent_servers['pidea'].env.FOO, '1')
  assert.equal(m.agent_servers['pidea'].command, '/opt/node/bin/node')
})

test('isEphemeralInstall detects the npx cache', () => {
  assert.ok(isEphemeralInstall('/opt/u/.npm/_npx/abc/node_modules/pidea/dist/index.js'))
  assert.ok(!isEphemeralInstall(base.scriptPath))
})

test('mergeConfig on an empty file enables IDE MCP', () => {
  const m = mergeConfig({}, 'pidea', buildEntry(base)) as any
  assert.equal(m.default_mcp_settings.use_idea_mcp, true)
})

test(
  'stableNodePath swaps a versioned pi-node path for the current link',
  { skip: process.platform === 'win32' },
  t => {
    const data = mkdtempSync(join(tmpdir(), 'pidea-setup-'))
    t.after(() => rmSync(data, { recursive: true, force: true }))
    const versioned = join(data, 'pi-node', 'node-v22.23.5-linux-x64', 'bin')
    mkdirSync(versioned, { recursive: true })
    writeFileSync(join(versioned, 'node'), '')
    symlinkSync(join(data, 'pi-node', 'node-v22.23.5-linux-x64'), join(data, 'pi-node', 'current'))
    const env = { XDG_DATA_HOME: data }

    assert.equal(stableNodePath(join(versioned, 'node'), env, 'linux'), join(data, 'pi-node', 'current', 'bin', 'node'))
    // Any other node (nvm, Homebrew, ...) stays as it is.
    assert.equal(stableNodePath(process.execPath, env, 'linux'), process.execPath)
    // No pi-node install at all.
    assert.equal(stableNodePath(process.execPath, { XDG_DATA_HOME: join(data, 'missing') }, 'linux'), process.execPath)
  }
)
