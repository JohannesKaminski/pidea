// Smoke: session/new startup prelude and loaded build identity.
// No model call: the prelude is generated from local context on session/new.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SmokeHarness, assert, matches } from './lib/acp-smoke.mjs'

// Own project with an AGENTS.md, so the Context section shows on any checkout.
const project = mkdtempSync(join(tmpdir(), 'pidea-smoke-project-'))
writeFileSync(join(project, 'AGENTS.md'), '# Smoke project\n')
process.on('exit', () => rmSync(project, { recursive: true, force: true }))

const h = new SmokeHarness().start()
try {
  const init = await h.expectResult(1, 'initialize', { protocolVersion: 1 })
  assert(init?.agentInfo?.name === 'pidea', `unexpected agent name: ${init?.agentInfo?.name}`)
  const build = init?.agentInfo?._meta?.pidea?.build
  assert(
    build && typeof build.revision === 'string' && build.revision.length > 0,
    `missing build identity: ${JSON.stringify(build)}`
  )

  const created = await h.expectResult(2, 'session/new', { cwd: project, mcpServers: [] })
  assert(typeof created?.sessionId === 'string' && created.sessionId.length > 0, 'missing sessionId')
  const startupInfo = created?._meta?.pidea?.startupInfo
  assert(typeof startupInfo === 'string' && startupInfo.length > 0, 'missing startupInfo')
  matches(startupInfo, /## Context/, 'startupInfo Context section')
  matches(startupInfo, /## Skills/, 'startupInfo Skills section')
  matches(startupInfo, /## Extensions/, 'startupInfo Extensions section')

  // Payload budget. The prelude carries the local skill/prompt inventory;
  // a pathological regression (duplicated sections, leaked dumps) must fail.
  const STARTUP_BUDGET = 32_000 // chars; current nominal ~9.6k
  assert(startupInfo.length <= STARTUP_BUDGET, `startupInfo ${startupInfo.length} chars exceeds ${STARTUP_BUDGET}`)
  const profile = startupInfo
    .split('\n## ')
    .slice(1)
    .map(s => `${s.split('\n')[0]}=${s.length}`)
    .join('; ')

  await h.close()
  h.assertExited(0)
  console.log(
    `OK smoke-startupinfo (dist ${h.distHash()}; build ${build.revision}; startupInfo ${startupInfo.length} chars; sections: ${profile})`
  )
} catch (err) {
  await h.close().catch(() => {})
  console.error(`FAIL smoke-startupinfo: ${err.message}`)
  if (h.stderr.length) console.error('adapter stderr tail:\n' + h.stderr.slice(-20).join(''))
  process.exit(1)
}
