import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ClientCapabilities,
  SessionConfigOption
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  SESSION_STATS_TIMEOUT_MS,
  type PiRpcEvent,
  type PiSessionStats
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { AcpMcpBridge } from './mcp-bridge.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultImages, toolResultToText, withoutImageData } from './translate/pi-tools.js'
import { toolKind, toolTitle } from './translate/tool-call.js'
import { parseSelectionPointer, renderSelections } from './translate/selection.js'
import { sessionExtensionEnv, sessionExtensionPaths } from './session-extensions.js'
import { defaultToolApprovalMode, toolApprovalConfigOption, toolApprovalPermissionOptions } from './tool-approval.js'
import { defaultFileAccessMode, fileAccessConfigOption } from './file-access.js'
import {
  FILE_ACCESS_COMMAND,
  decodeFileRequest,
  type EditorFileRequest,
  type EditorFileResponse,
  type FileAccessMode
} from '../pi-extension/editor-files-protocol.js'
import {
  APPROVAL_REJECT,
  TOOL_APPROVAL_COMMAND,
  decodeApprovalTitle,
  type ToolApprovalMode,
  type ToolApprovalRequest
} from '../pi-extension/tool-approval.js'
import { withTimeout } from './usage.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  bridge?: AcpMcpBridge
  extensionPaths?: string[]
  env?: Record<string, string | undefined>
}

export type StopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'error'

type PendingTurn = {
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'
const EXTENSION_PROBE_TIMEOUT_MS = 5_000

/**
 * Map pi's `stats.contextUsage` (plus cumulative `cost`) to an ACP `usage_update`. Returns null whenever pi
 * reports no trustworthy token count (e.g. `tokens: null` right after compaction) or
 * the values are not usable integers.
 */
function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

  // pi prices models in USD per million tokens, so its cumulative session cost is USD.
  const cost = stats?.cost
  const hasCost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0

  return { sessionUpdate: 'usage_update', used, size, ...(hasCost ? { cost: { amount: cost, currency: 'USD' } } : {}) }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * Canonical absolute path (symlinks resolved), so paths pi reports (real paths) match paths
 * the adapter derives from the session cwd. A file that doesn't exist yet resolves via its directory.
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p))
    } catch {
      return p
    }
  }
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PideaSession>()
  private readonly closing = new Map<string, { session: PideaSession; promise: Promise<void> }>()
  private readonly store = new SessionStore()
  /** The client's capabilities from `initialize`; omitted ones count as unsupported. */
  clientCapabilities: ClientCapabilities = {}
  /** Called when pi changes session config on its own (e.g. thinking level); the agent re-sends config options. */
  onConfigChanged: ((session: PideaSession) => Promise<void> | void) | undefined

  /** Dispose all sessions and their underlying pi subprocesses. */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id).catch(() => undefined)))
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PideaSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session, and we want a fresh Pi subprocess.
   */
  close(sessionId: string): void {
    void this.closeSession(sessionId).catch(() => undefined)
  }

  async closeSession(sessionId: string): Promise<void> {
    const existing = this.closing.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return
    // A concurrent restore can install a new session under the same id while
    // the previous one is still closing; only reuse the in-flight promise when
    // it belongs to the exact session instance being closed.
    if (existing && existing.session === session) return existing.promise

    // Remove it before awaiting disposal so incoming MCP messages cannot route to a closing bridge.
    this.sessions.delete(sessionId)
    const promise = session.dispose().finally(() => {
      if (this.closing.get(sessionId)?.session === session) this.closing.delete(sessionId)
    })
    this.closing.set(sessionId, { session, promise })
    await promise
  }

  /** Close all sessions except the one with `keepSessionId`. */
  // noinspection JSUnusedGlobalSymbols
  closeAllExcept(keepSessionId: string): void {
    void this.closeAllExceptAsync(keepSessionId).catch(() => undefined)
  }

  async closeAllExceptAsync(keepSessionId: string): Promise<void> {
    await Promise.all([...this.sessions.keys()].filter(id => id !== keepSessionId).map(id => this.closeSession(id)))
  }

  async handleIncomingMcpMessage(
    params: Record<string, unknown>,
    notification: boolean
  ): Promise<Record<string, unknown>> {
    const connectionId = params.connectionId
    if (typeof connectionId !== 'string') throw new Error('mcp/message is missing connectionId')
    for (const session of this.sessions.values()) {
      if (session.ownsMcpConnection(connectionId)) {
        return session.handleIncomingMcpMessage(params, notification)
      }
    }
    throw new Error(`Unknown MCP connection: ${connectionId}`)
  }

  async create(params: SessionCreateParams): Promise<PideaSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        extensionPaths: sessionExtensionPaths(params.extensionPaths),
        env: { ...params.env, ...sessionExtensionEnv(this.clientCapabilities) }
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    type PiState = { sessionId?: string; sessionFile?: string }
    let state: PiState | null = null
    try {
      state = ((await proc.getState()) as PiState | null | undefined) ?? null
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state?.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state?.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PideaSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      bridge: params.bridge,
      clientCapabilities: this.clientCapabilities,
      onConfigChanged: this.onConfigChanged,
      autoTitle: true
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PideaSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(undefined, `Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PideaSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PideaSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      bridge: params.bridge,
      clientCapabilities: this.clientCapabilities,
      onConfigChanged: this.onConfigChanged,
      autoTitle: false
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PideaSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false
  private initialTitlePending: boolean
  private lastPublishedTitle: string | null | undefined
  private titleUpdateQueue: Promise<void> = Promise.resolve()

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly bridge: AcpMcpBridge | undefined
  private readonly clientCapabilities: ClientCapabilities
  private readonly onConfigChanged: ((session: PideaSession) => Promise<void> | void) | undefined

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false
  private settledTurnStats: PiSessionStats | null | undefined = undefined
  // Stop reason and error of the turn's latest assistant message. pi may retry, compact
  // or continue after an error, so only the last one before agent_settled decides.
  private lastAssistantStop: { stopReason?: unknown; errorMessage?: unknown } | null = null
  // ACP messageId of the pi assistant message being streamed; its thinking and text
  // chunks share it. Chunks outside a pi message (adapter notices) get their own id.
  private currentMessageId: string | null = null
  // Settings carried out by the bundled pi extensions: tool approval (src/acp/tool-approval.ts)
  // and editor file access (src/acp/file-access.ts). Initialized lazily on first use: one probe
  // checks which extensions pi loaded, then each default is applied. `pending` holds a change
  // requested mid-turn, applied when the turn settles.
  private readonly extensionSettings = {
    approval: {
      command: TOOL_APPROVAL_COMMAND,
      mode: 'off' as string,
      available: false,
      pending: null as string | null
    },
    files: { command: FILE_ACCESS_COMMAND, mode: 'disk' as string, available: false, pending: null as string | null }
  }
  private extensionSettingsInit: Promise<void> | null = null
  // Text the editor returned and received per absolute path during the current tool call,
  // for structured diffs in editor file-access mode (the disk may not have the edit yet).
  private readonly editorReads = new Map<string, string>()
  private readonly editorWrites = new Map<string, string>()
  // A config-option refresh triggered by pi mid-turn; settled before the turn ends.
  private pendingConfigRefresh: Promise<void> = Promise.resolve()

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  /** Paths touched by file-mutation tool calls this turn; feeds the inspection gate's extraFiles. */
  readonly touchedFilePaths = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()
  private disposePromise: Promise<void> | undefined

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    bridge?: AcpMcpBridge
    clientCapabilities?: ClientCapabilities
    onConfigChanged?: (session: PideaSession) => Promise<void> | void
    autoTitle?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.bridge = opts.bridge
    this.clientCapabilities = opts.clientCapabilities ?? {}
    this.onConfigChanged = opts.onConfigChanged
    this.initialTitlePending = opts.autoTitle ?? false

    this.proc.onEvent(ev => this.handlePiEvent(ev))
    this.proc.onExit?.((code, signal) => this.handleProcessExit(code, signal))
  }

  ownsMcpConnection(connectionId: string): boolean {
    return this.bridge?.ownsConnection(connectionId) ?? false
  }

  async handleIncomingMcpMessage(
    params: Record<string, unknown>,
    notification: boolean
  ): Promise<Record<string, unknown>> {
    if (!this.bridge) throw new Error('Session has no MCP bridge')
    const before = this.bridge.diagnostics.length
    const result = await this.bridge.handleIncomingMcpMessage(params, notification)
    // Surface tools/list_changed after startup: the catalog is a per-session snapshot,
    // so the client should start a new chat to refresh.
    if (notification && String(params?.method ?? '') === 'notifications/tools/list_changed') {
      if (this.bridge.diagnostics.length > before && !this.listChangedSurfaced) {
        this.listChangedSurfaced = true
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: {
            pidea: {
              mcp: 'IDE bridge: tools/list_changed advertised; the catalog is a session snapshot — start a new chat to refresh'
            }
          }
        })
      }
    }
    return result
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  lastError: string | null = null
  /** Set once so tools/list_changed is surfaced at most once per session. */
  private listChangedSurfaced = false

  /**
   * Idempotent session disposal: end queued work, dispose the IDE bridge
   * (rejects pending bridge calls, closes IPC, disconnects ACP MCP servers
   * exactly once), then terminate the owned pi subprocess.
   */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = (async () => {
      for (const q of this.turnQueue) q.reject(new Error('session disposed'))
      this.turnQueue.length = 0
      this.cancelRequested = true
      // Settle an in-flight ACP prompt so the request never hangs.
      const running = this.pendingTurn
      if (running) {
        this.pendingTurn = null
        void this.flushEmits().finally(() => running.resolve('cancelled'))
      }
      this.bridge?.cancelAll()
      try {
        await this.bridge?.dispose()
      } finally {
        this.proc.dispose?.()
        await this.proc.waitForExit?.()
      }
    })()
    return this.disposePromise
  }

  get bridgeStatus() {
    return this.bridge?.status
  }

  get bridgeRegisteredTools() {
    const registered = new Set((this.bridge?.registration?.registered ?? []).map(item => item.exposedName))
    return (this.bridge?.tools ?? []).filter(tool => registered.has(tool.exposedName))
  }

  get hasMcpBridge(): boolean {
    return this.bridge?.hasServers ?? false
  }

  /** The session's MCP bridge, for adapter-side inspection/tool use. */
  get mcpBridge(): AcpMcpBridge | undefined {
    return this.bridge
  }

  async prompt(message: string, images: unknown[] = [], title?: string): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, title, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { pidea: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { pidea: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Cancel active IDE bridge tool calls for this turn before the (potentially slow)
    // pi abort RPC: bridge cancellation must never wait on pi mid-generation.
    this.bridge?.cancelAll()
    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  async setSessionName(name: string): Promise<void> {
    return this.enqueueTitleUpdate(async () => {
      await this.proc.setSessionName(name)
      this.publishTitle(name)
    })
  }

  private enqueueTitleUpdate(update: () => Promise<void>): Promise<void> {
    const result = this.titleUpdateQueue.then(update)
    this.titleUpdateQueue = result.catch(() => {})
    return result
  }

  publishTitle(title: string | null, updatedAt: string | null = new Date().toISOString()): Promise<void> {
    if (this.lastPublishedTitle === title) return this.lastEmit
    this.lastPublishedTitle = title
    this.emit({
      sessionUpdate: 'session_info_update',
      title,
      ...(updatedAt ? { updatedAt } : {})
    })
    return this.lastEmit
  }

  private async maybeAutoTitle(title?: string): Promise<void> {
    if (!this.initialTitlePending || !title) return
    this.initialTitlePending = false

    try {
      await this.enqueueTitleUpdate(async () => {
        const state = (await this.proc.getState()) as { sessionName?: unknown } | null
        const currentTitle = typeof state?.sessionName === 'string' ? state.sessionName.trim() : ''
        if (currentTitle) {
          this.publishTitle(currentTitle)
          return
        }
        if (this.lastPublishedTitle) return

        await this.proc.setSessionName(title)
        this.publishTitle(title)
      })
    } catch {
      // Auto-titling is best-effort and must not fail the completed prompt.
    }
  }

  private emit(update: SessionUpdate): void {
    if (
      (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') &&
      !update.messageId
    ) {
      update = { ...update, messageId: this.currentMessageId ?? crypto.randomUUID() }
    }

    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage(): Promise<PiSessionStats | null> {
    let stats: PiSessionStats | null = null
    try {
      // Older/stubbed pi processes may not expose the stats RPC at all.
      if (typeof this.proc.getSessionStats === 'function') {
        stats = await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS)
        const update = toUsageUpdate(stats)
        if (update) this.emit(update)
      }
    } catch {
      // Context usage is auxiliary; never fail or delay the turn because of it.
    }

    await this.flushEmits()
    return stats
  }

  /**
   * Stats fetched when the last turn settled, so the agent can build the prompt response
   * `usage` without a second `get_session_stats` round trip. `null` means the fetch failed;
   * `undefined` means the turn ended without settling (error, exit, dispose). Clears on read.
   */
  takeSettledTurnStats(): PiSessionStats | null | undefined {
    const stats = this.settledTurnStats
    this.settledTurnStats = undefined
    return stats
  }

  private async settleTurn(): Promise<void> {
    // Ensure all updates derived from pi events (plus the final usage update) are
    // delivered before we resolve the ACP `session/prompt` request.
    this.settledTurnStats = await this.publishContextUsage()
    await this.pendingConfigRefresh

    const reason = this.settledStopReason()
    this.pendingTurn?.resolve(reason)
    this.pendingTurn = null

    for (const setting of Object.values(this.extensionSettings)) {
      const mode = setting.pending
      if (mode === null) continue
      setting.pending = null
      await this.sendExtensionCommand(setting.command, mode).catch(() => {})
    }

    // Start next queued prompt, if any.
    const next = this.turnQueue.shift()
    if (next) {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      })
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { pidea: { queueDepth: 0, running: false } }
      })
    }
  }

  /** Maps the turn's final pi stop reason to the ACP outcome; `error` also records lastError. */
  private settledStopReason(): StopReason {
    if (this.cancelRequested) return 'cancelled'
    const final = this.lastAssistantStop
    switch (final?.stopReason) {
      case 'length':
        return 'max_tokens'
      case 'aborted':
        return 'cancelled'
      case 'error':
        this.lastError =
          typeof final.errorMessage === 'string' && final.errorMessage ? final.errorMessage : 'pi model request failed'
        return 'error'
      default:
        return 'end_turn'
    }
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      ...(params.sessionUpdate === 'tool_call' ? { name: params.toolName } : {}),
      title: toolTitle(params.toolName, params.args, this.cwd),
      kind: toolKind(params.toolName, params.args),
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
      // Valid as either a tool_call or a tool_call_update; TS can't narrow the computed union.
    } as SessionUpdate)
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    const snapshot = this.fileSnapshots.get(toolCallId)
    if (snapshot) {
      const key = canonicalPath(isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path))
      this.editorReads.delete(key)
      this.editorWrites.delete(key)
    }
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.lastAssistantStop = null

    this.pendingTurn = { title: t.title, resolve: t.resolve, reject: t.reject }
    void this.maybeAutoTitle(t.title)

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { pidea: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before we get `agent_settled`, treat as error unless canceled.
      // Also ensure we flush any already-enqueued updates first.
      void this.flushEmits().finally(() => {
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          if (reason === 'error') {
            const tail = this.proc.stderrTailLines(8).join('\n')
            this.lastError = `${err instanceof Error ? err.message : String(err)}${tail ? `\nstderr:\n${tail}` : ''}`
          }
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { pidea: { queueDepth: this.turnQueue.length, running: false } }
        })
      })
      void err
    })
  }

  /** Process exit while a turn is running settles the ACP prompt. */
  private handleProcessExit(code: number | null, signal: string | null): void {
    const t = this.pendingTurn
    if (!t) return
    this.pendingTurn = null
    const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
    if (reason === 'error') {
      const tail = typeof this.proc.stderrTailLines === 'function' ? this.proc.stderrTailLines(8).join('\n') : ''
      this.lastError = `pi process exited (code=${code}, signal=${signal})${tail ? `\nstderr:\n${tail}` : ''}`
    }
    void this.flushEmits().finally(() => t.resolve(reason))
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'session_info_changed': {
        // pi named (or unnamed) the session: the chat title follows. Malformed names are ignored.
        const name = (ev as { name?: unknown }).name
        if (typeof name === 'string' || name === undefined) this.publishTitle(name ?? null)
        break
      }

      case 'thinking_level_changed': {
        // pi changed the level on its own (extension, cycle): keep the client's selector in sync.
        // The turn waits for this refresh before it ends (see settleTurn).
        this.pendingConfigRefresh = Promise.resolve(this.onConfigChanged?.(this)).catch(() => {})
        break
      }

      case 'extension_error': {
        // A failing pi extension would otherwise go unnoticed.
        const path = typeof ev.extensionPath === 'string' ? basename(ev.extensionPath) : 'unknown extension'
        const where = typeof ev.event === 'string' && ev.event ? ` (${ev.event})` : ''
        const detail = typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error)
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `pi extension error in ${path}${where}: ${detail}\n\n` } satisfies ContentBlock
        })
        break
      }

      case 'message_start': {
        const message = ev.message as { role?: unknown } | undefined
        if (message?.role === 'assistant') this.currentMessageId = crypto.randomUUID()
        break
      }

      case 'message_end': {
        const message = ev.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined
        if (message?.role === 'assistant') {
          this.lastAssistantStop = { stopReason: message.stopReason, errorMessage: message.errorMessage }
          this.currentMessageId = null
        }
        break
      }

      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                name: toolName,
                title: toolTitle(toolName, rawInput, this.cwd),
                kind: toolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                title: toolTitle(toolName, rawInput, this.cwd),
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) this.touchedFilePaths.add(p)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            name: toolName,
            title: toolTitle(toolName, args, this.cwd),
            kind: toolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          // Arguments are complete now; refresh the title built from streamed partial args.
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            title: toolTitle(toolName, args, this.cwd),
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            // In editor file-access mode the edit went to the editor, which may not have saved it yet:
            // use the text the editor gave and received instead of the disk.
            const key = canonicalPath(abs)
            const editorNew = this.editorWrites.get(key)
            const oldText = editorNew !== undefined ? (this.editorReads.get(key) ?? snapshot.oldText) : snapshot.oldText
            const newText = editorNew ?? readFileSync(abs, 'utf8')
            if (oldText === null || newText !== oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }
        const images = toolResultImages(result)
        if (images.length > 0) content = [...(content ?? []), ...images]

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: withoutImageData(result) })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start': {
        const text = formatCompactionStart(ev)
        if (text) {
          this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } satisfies ContentBlock })
        }
        break
      }

      case 'compaction_end': {
        const text = formatCompactionEnd(ev)
        if (text) {
          this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } satisfies ContentBlock })
        }
        break
      }

      case 'agent_start': {
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        break
      }

      case 'agent_settled': {
        void this.settleTurn()
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      const approval = decodeApprovalTitle(ev.title)
      if (approval) await this.handleToolApproval(id, approval)
      else await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input') {
      const fileRequest = decodeFileRequest(ev.title)
      if (fileRequest) await this.handleEditorFileRequest(id, fileRequest)
      else await this.handleExtensionInput(ev, id)
      return
    }

    if (method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Pi editor UI request is not supported in ACP (no multiline elicitation form); cancelling it.'
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        _meta: { pidea: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  /**
   * Replaces IntelliJ selection pointers (byte offsets in an embedded JSON resource) with the
   * selected text and its line range. The file is read the way the session's file access says
   * (the editor includes unsaved changes; offsets refer to the editor's text). Blocks that
   * can't be resolved pass through unchanged.
   */
  async resolveSelectionPointers<T>(blocks: T[]): Promise<T[]> {
    if (!blocks.some(b => parseSelectionPointer(b))) return blocks
    await this.ensureExtensionSettings()
    const viaEditor = this.extensionSettings.files.available && this.extensionSettings.files.mode === 'editor'
    return Promise.all(
      blocks.map(async block => {
        const pointer = parseSelectionPointer(block)
        if (!pointer) return block
        try {
          const content = viaEditor
            ? (await this.conn.readTextFile({ sessionId: this.sessionId, path: pointer.path })).content
            : await readFile(pointer.path, 'utf8')
          const text = renderSelections(content, pointer, this.cwd)
          // Start on its own line: the prompt converter appends blocks directly to each other.
          return text ? ({ type: 'text', text: `\n\n${text}` } as T) : block
        } catch {
          return block
        }
      })
    )
  }

  /** The tool approval config option, or null when pi didn't load the approval extension. */
  async toolApprovalOption(): Promise<SessionConfigOption | null> {
    await this.ensureExtensionSettings()
    const { available, mode } = this.extensionSettings.approval
    return available ? toolApprovalConfigOption(mode as ToolApprovalMode) : null
  }

  async setToolApprovalMode(mode: ToolApprovalMode): Promise<void> {
    await this.setExtensionSetting(
      'approval',
      mode,
      'Tool approval is unavailable: the pi approval extension is not loaded'
    )
  }

  /** The file access config option, or null without the extension or the client's fs support. */
  async fileAccessOption(): Promise<SessionConfigOption | null> {
    await this.ensureExtensionSettings()
    const { available, mode } = this.extensionSettings.files
    return available ? fileAccessConfigOption(mode as FileAccessMode) : null
  }

  async setFileAccessMode(mode: FileAccessMode): Promise<void> {
    await this.setExtensionSetting(
      'files',
      mode,
      'Editor file access is unavailable: it needs the pi file extension and client fs read/write support'
    )
  }

  private async setExtensionSetting(
    key: keyof PideaSession['extensionSettings'],
    mode: string,
    unavailable: string
  ): Promise<void> {
    await this.ensureExtensionSettings()
    const setting = this.extensionSettings[key]
    if (!setting.available) throw RequestError.invalidParams(undefined, unavailable)
    // An RPC prompt during a running turn could be queued as steering text; wait for the turn to settle.
    if (this.pendingTurn) setting.pending = mode
    else await this.sendExtensionCommand(setting.command, mode)
    setting.mode = mode
  }

  private ensureExtensionSettings(): Promise<void> {
    this.extensionSettingsInit ??= (async () => {
      let names = new Set<string>()
      try {
        // Only send an internal command once pi lists it; otherwise the text would reach the model.
        // Bounded: a pi that never answers must not hold up session setup for the full RPC timeout.
        const data = (await this.proc.getCommands?.(EXTENSION_PROBE_TIMEOUT_MS)) as
          | { commands?: Array<{ name?: unknown }> }
          | undefined
        names = new Set((data?.commands ?? []).map(c => String(c?.name)))
      } catch {
        // Treat as no extensions loaded.
      }
      const { approval, files } = this.extensionSettings
      const fs = this.clientCapabilities.fs
      approval.available = names.has(approval.command)
      files.available = names.has(files.command) && fs?.readTextFile === true && fs?.writeTextFile === true

      const defaults: Array<[typeof approval, string, string]> = [
        [approval, defaultToolApprovalMode(), 'off'],
        [files, defaultFileAccessMode(), 'disk']
      ]
      for (const [setting, mode, inert] of defaults) {
        if (!setting.available || mode === inert) continue
        try {
          await this.sendExtensionCommand(setting.command, mode)
          setting.mode = mode
        } catch {
          // Keep the inert mode.
        }
      }
    })()
    return this.extensionSettingsInit
  }

  private async sendExtensionCommand(command: string, mode: string): Promise<void> {
    await this.proc.prompt(`/${command} ${mode}`)
  }

  /** Serves the file extension's marked input dialog via the client's fs/read_text_file and fs/write_text_file. */
  private async handleEditorFileRequest(id: string, req: EditorFileRequest): Promise<void> {
    let res: EditorFileResponse
    try {
      if (req.op === 'read') {
        const { content } = await this.conn.readTextFile({ sessionId: this.sessionId, path: req.path })
        const key = canonicalPath(req.path)
        if (!this.editorReads.has(key)) this.editorReads.set(key, content)
        res = { ok: true, content }
      } else {
        await this.conn.writeTextFile({ sessionId: this.sessionId, path: req.path, content: req.content })
        this.editorWrites.set(canonicalPath(req.path), req.content)
        res = { ok: true }
      }
    } catch (error) {
      res = {
        ok: false,
        error: `Editor ${req.op} failed for ${req.path}: ${(error as Error)?.message ?? String(error)}`
      }
    }
    await this.proc.sendExtensionUiResponse({ id, value: JSON.stringify(res) })
  }

  /** Turns the approval extension's marked select dialog into an ACP permission request. */
  private async handleToolApproval(id: string, req: ToolApprovalRequest): Promise<void> {
    let value: string = APPROVAL_REJECT
    try {
      const res = await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: { toolCallId: req.toolCallId, status: 'pending' },
        options: toolApprovalPermissionOptions(req.toolName)
      })
      if (res.outcome.outcome === 'selected') value = res.outcome.optionId
    } catch {
      // No answer means no approval.
    }
    await this.proc.sendExtensionUiResponse({ id, value })
  }

  private async handleExtensionInput(ev: PiRpcEvent, id: string): Promise<void> {
    const title = stringProp(ev, 'title') ?? 'Pi input'
    const placeholder = stringProp(ev, 'placeholder')
    const timeout = typeof ev.timeout === 'number' && ev.timeout > 0 ? ev.timeout : 300_000

    if (!this.clientCapabilities.elicitation?.form) {
      await this.cancelUnsupportedInput(id)
      return
    }

    try {
      const response = await withTimeout(
        this.conn.createElicitation({
          mode: 'form',
          sessionId: this.sessionId,
          message: title,
          requestedSchema: {
            type: 'object',
            title,
            properties: {
              value: {
                type: 'string',
                ...(placeholder ? { description: placeholder } : {})
              }
            },
            required: ['value']
          }
        }),
        timeout
      )

      const value =
        response.action === 'accept'
          ? (response.content as Record<string, unknown> | null | undefined)?.value
          : undefined
      if (typeof value !== 'string') {
        await this.proc.sendExtensionUiResponse({ id, cancelled: true })
        return
      }
      await this.proc.sendExtensionUiResponse({ id, value })
    } catch {
      // The client declared form elicitation but the request failed: cancel visibly so pi never hangs.
      await this.cancelUnsupportedInput(id)
    }
  }

  private async cancelUnsupportedInput(id: string): Promise<void> {
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'Pi input UI request is not supported by this ACP client; cancelling it.'
      } satisfies ContentBlock
    })
    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

// pi emits compaction_start/end for manual and automatic compaction. Manual `/compact`
// already reports its result through the slash command, so only automatic runs are announced.
function formatCompactionStart(ev: PiRpcEvent): string | null {
  switch (ev.reason) {
    case 'threshold':
      return 'Context nearing limit; running automatic compaction...\n\n'
    case 'overflow':
      return 'Context window exceeded; compacting and retrying...\n\n'
    default:
      return null
  }
}

function formatCompactionEnd(ev: PiRpcEvent): string | null {
  if (ev.reason !== 'threshold' && ev.reason !== 'overflow') return null
  if (ev.aborted === true) return 'Compaction cancelled.\n\n'
  if (typeof ev.errorMessage === 'string' && ev.errorMessage) return `Compaction failed: ${ev.errorMessage}\n\n`
  return 'Compaction finished; earlier context was summarized.\n\n'
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}
