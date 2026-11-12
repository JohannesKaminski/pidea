import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { PideaAgent } from './acp/agent.js'
import { createAcpDebugLog, lineTap } from './acp/debug-log.js'
import { exitOnCrash } from './exit-on-crash.js'
import { getPiCommand, shouldUseShellForPiCommand } from './pi-rpc/command.js'
// `pidea setup`: write the IntelliJ agent entry (~/.jetbrains/acp.json). ACP clients launch the
// adapter without arguments, so this never collides with a session.
if (process.argv[2] === 'setup') {
  const { runSetup } = await import('./setup.js')
  try {
    process.exit(runSetup(process.argv.slice(3)))
  } catch (e) {
    process.stderr.write(`pidea setup: ${(e as Error).message}\n`)
    process.exit(1)
  }
}

// `pidea update [--check]`: install the latest GitHub release into the same global prefix.
if (process.argv[2] === 'update') {
  const { defaultUpdateDeps, runUpdate } = await import('./update.js')
  process.exit(await runUpdate(process.argv.slice(3), defaultUpdateDeps()))
}

// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(process.env.PIDEA_PI_COMMAND)
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `pidea: could not start pi (command not found: ${cmd}). Install pi with its installer (https://pi.dev), or put \`pi\` on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

// Opt-in ACP traffic log (PIDEA_DEBUG_ACP); see src/acp/debug-log.ts.
const debugLog = createAcpDebugLog(process.env.PIDEA_DEBUG_ACP)
const tapOutgoing = debugLog ? lineTap(line => debugLog.outgoing(line)) : null
const tapIncoming = debugLog ? lineTap(line => debugLog.incoming(line)) : null

// Agent → client (stdout).
const input = new WritableStream<Uint8Array>({
  write(chunk) {
    tapOutgoing?.(chunk)
    return new Promise<void>(resolve => {
      if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
        resolve()
      }
    })
  }
})

// Client → agent (stdin).
const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => {
      tapIncoming?.(chunk)
      controller.enqueue(new Uint8Array(chunk))
    })
    process.stdin.on('end', () => controller.close())
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

// Retain the agent so shutdown can dispose owned pi subprocesses. The SDK's
// AgentSideConnection does not expose the handler instance it created.
let activeAgent: PideaAgent | null = null
new AgentSideConnection(conn => {
  activeAgent = new PideaAgent(conn)
  return activeAgent
}, stream)

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    // Dispose session subprocesses (and the IDE bridge) before exiting so no
    // pi or MCP child is orphaned when the client disconnects.
    const a = activeAgent
    activeAgent = null
    if (a) await a.dispose()
  } catch {
    // ignore; the exit below is authoritative
  }
  try {
    process.exit(0)
  } catch {
    // ignore
  }
}

process.stdin.on('end', () => void shutdown())
process.stdin.on('close', () => void shutdown())

process.stdin.resume()
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Avoid crashing if the client closes stdout early.
process.stdout.on('error', () => {
  try {
    process.exit(0)
  } catch {
    // ignore
  }
})

// Last-resort crash handlers: log, dispose owned children best-effort, then exit
// nonzero so the client can surface the failure (a dead-but-zero adapter would
// look like an idle session).
process.on('uncaughtException', error => {
  const a = activeAgent
  activeAgent = null
  exitOnCrash('uncaught exception', error, a ? () => a.dispose() : null)
})
process.on('unhandledRejection', reason => {
  const a = activeAgent
  activeAgent = null
  exitOnCrash('unhandled rejection', reason, a ? () => a.dispose() : null)
})
