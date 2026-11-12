import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import crossSpawn from 'cross-spawn'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import { terminateProcessTree } from '../process-tree.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Session branching
  | { type: 'fork'; id?: string; entryId: string }
  | { type: 'get_entries'; id?: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

/** Maximum wait for an auxiliary context-usage update. */
export const SESSION_STATS_TIMEOUT_MS = 1_000

/**
 * Shape of `stats.contextUsage` in pi's `get_session_stats` response.
 * `tokens` is null while pi has no trustworthy token count (e.g. right after compaction).
 */
export type PiContextUsage = {
  tokens?: number | null
  contextWindow?: number | null
}

export type PiSessionStats = {
  sessionId?: string
  sessionFile?: string
  totalMessages?: number
  cost?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  contextUsage?: PiContextUsage | null
}

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** Extra pi extensions to load via `--extension` (e.g. the ACP MCP bridge extension). */
  extensionPaths?: string[]
  /** Deadline for each pi RPC request; bounds silent pi processes (default 30s). */
  requestTimeoutMs?: number
  /** Per-child environment overlay merged over process.env (e.g. bridge IPC credentials). */
  env?: Record<string, string | undefined>
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private readonly requestTimeoutMs: number
  private readonly exitPromise: Promise<void>
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly stderrTail: string[] = []
  private exitStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private readonly exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  /** Bounded tail of retained child stderr for diagnostics; the raw stream stays untouched. */
  stderrTailLines(limit = 40): string[] {
    return this.stderrTail.slice(-limit)
  }

  /** Register a handler invoked when the child process exits. */
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.push(handler)
  }

  private constructor(child: ChildProcessWithoutNullStreams, requestTimeoutMs = 30_000) {
    this.child = child
    this.requestTimeoutMs = requestTimeoutMs
    this.exitPromise = new Promise(resolve => {
      child.once('exit', () => resolve())
      child.once('close', () => resolve())
    })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: Record<string, unknown> | null = null
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts; it is not protocol.
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        // `resolve` removes the pending entry. Responses for unknown or already timed-out
        // ids are dropped: a response is never a pi event, so it must not be broadcast.
        if (id !== undefined) this.pending.get(id)?.resolve(msg as PiRpcResponse)
        return
      }

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.on('exit', (code, signal) => {
      this.exitStatus = { code, signal }
      const err = this.exitedError()
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      for (const h of this.exitHandlers) h(code, signal)
    })

    child.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })

    child.stderr.on('data', chunk => {
      // Retain a bounded tail for diagnostics; the raw stream stays untouched so ACP
      // clients (which capture stderr) still receive the original output.
      for (const line of String(chunk).split('\n')) {
        if (line.length > 0) this.stderrTail.push(line)
      }
      if (this.stderrTail.length > 200) this.stderrTail.splice(0, this.stderrTail.length - 200)
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)
    for (const ext of params.extensionPaths ?? []) {
      args.push('--extension', ext)
    }

    // Windows cmd launchers need shell escaping; direct executables use native argv.
    const start = shouldUseShellForPiCommand(cmd) ? crossSpawn : spawn
    const child = start(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: { ...process.env, ...params.env }
    }) as ChildProcessWithoutNullStreams

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: Error) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: error }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: error })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: error })
    }

    const proc = new PiRpcProcess(child, params.requestTimeoutMs ?? 30_000)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as { sessionFile?: unknown } | null
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null) return
    terminateProcessTree(this.child, typeof signal === 'string' ? signal : 'SIGTERM')
  }

  async waitForExit(timeoutMs = 1_000): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true
    this.dispose()
    await Promise.race([
      this.exitPromise,
      new Promise(resolve => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
    ])
    if (this.child.exitCode !== null || this.child.signalCode !== null) return true
    // The child ignored SIGTERM; force termination and give it one more short
    // grace period before reporting failure.
    terminateProcessTree(this.child, 'SIGKILL')
    await Promise.race([
      this.exitPromise,
      new Promise(resolve => {
        const timer = setTimeout(resolve, 500)
        timer.unref?.()
      })
    ])
    return this.child.exitCode !== null || this.child.signalCode !== null
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success)
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    const levels = data && typeof data === 'object' && 'levels' in data ? data.levels : undefined
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every(level => typeof level === 'string' && level.length > 0)
    ) {
      throw new Error('pi get_available_thinking_levels returned invalid levels')
    }
    return levels
  }

  async setThinkingLevel(level: string): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions }, 120_000)
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(timeoutMs?: number): Promise<PiSessionStats> {
    const res = await this.request({ type: 'get_session_stats' }, timeoutMs)
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data ?? {}) as PiSessionStats
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath }, 120_000)
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data as { path?: unknown } | null
    return { path: String(data?.path ?? '') }
  }
  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const res = await this.request({ type: 'fork', entryId })
    if (!res.success) throw new Error(`pi fork failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data as { text?: unknown; cancelled?: unknown } | undefined
    return { text: String(data?.text ?? ''), cancelled: Boolean(data?.cancelled) }
  }

  async getEntries(): Promise<unknown> {
    const res = await this.request({ type: 'get_entries' })
    if (!res.success) throw new Error(`pi get_entries failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(timeoutMs?: number): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' }, timeoutMs)
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, timeoutMs: number = this.requestTimeoutMs): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      // Returns false when the id was already dropped (e.g. by the timeout), so the
      // caller can avoid settling the promise twice.
      const drop = (): boolean => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return this.pending.delete(id)
      }

      this.pending.set(id, {
        resolve: res => {
          drop()
          resolve(res)
        },
        reject: error => {
          drop()
          reject(error)
        }
      })

      timer = setTimeout(() => {
        timer = undefined
        if (!this.pending.delete(id)) return
        reject(new Error(`pi RPC ${cmd.type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // Never let a request timer keep the event loop alive.
      timer.unref?.()

      void this.writeLine(line).catch(error => {
        if (!drop()) return
        reject(error)
      })
    })
  }

  /**
   * Error for talking to a pi that has exited: its exit status and the end of its stderr, so
   * clients see why pi stopped instead of a bare stream error.
   */
  private exitedError(): Error {
    const status = this.exitStatus ? `code=${this.exitStatus.code}, signal=${this.exitStatus.signal}` : 'stdin closed'
    const tail = this.stderrTailLines(8).join('\n')
    return new Error(`pi process exited (${status})${tail ? `\nstderr:\n${tail}` : ''}`)
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.exitStatus || this.child.stdin.destroyed) {
        reject(this.exitedError())
        return
      }
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            // Writing failed because pi went away (EPIPE, stream destroyed): report why it exited.
            reject(this.exitStatus || this.child.stdin.destroyed ? this.exitedError() : error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(this.exitStatus || this.child.stdin.destroyed ? this.exitedError() : error)
      }
    })
  }
}
