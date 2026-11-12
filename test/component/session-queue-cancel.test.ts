import test from 'node:test'
import assert from 'node:assert/strict'
import { PideaSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PideaSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PideaSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  // first started, second+third queued
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  // Queued prompts should resolve as canceled.
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  // Finish the first prompt as canceled after abort.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')

  // queue should have been cleared, so no further prompt started
  assert.equal(proc.prompts.length, 1)
})

test('PideaSession: process exit settles the running prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PideaSession({
    sessionId: 's3',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const turn = session.prompt('one')
  assert.equal(proc.prompts.length, 1)
  proc.exit(1, null)
  assert.equal(await turn, 'error')
  assert.ok(String((session as any).lastError).includes('pi process exited'), 'lastError missing exit diagnostic')
})

test('PideaSession: dispose settles the running prompt as cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PideaSession({
    sessionId: 's4',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const turn = session.prompt('one')
  await session.dispose()
  assert.equal(await turn, 'cancelled')
})

test('PideaSession: cancel cancels the bridge before awaiting the pi abort', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const order: string[] = []
  // noinspection JSUnusedGlobalSymbols
  const bridge = { cancelAll: () => order.push('bridge') }
  ;(proc as any).abort = async () => {
    order.push('proc')
  }

  const session = new PideaSession({
    sessionId: 's2',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    bridge: bridge as any,
    fileCommands: []
  })

  const first = session.prompt('one')
  await session.cancel()
  assert.equal(order.join(','), 'bridge,proc')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')
})
