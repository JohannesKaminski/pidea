import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ENTRY_NAME = 'pidea'

export interface SetupOptions {
  /** Absolute path of the node binary that should run the adapter. */
  nodePath: string
  /** Absolute path of the adapter's dist/index.js. */
  scriptPath: string
  /** Absolute path of the pi launcher, or null when it was not found. */
  piPath: string | null
  /** Extra PATH folders, appended after the node and pi folders. */
  basePath: string
  platform?: NodeJS.Platform
}

type Json = Record<string, unknown>

/** True when the script lives in npx's throwaway cache, which can be deleted at any time. */
export function isEphemeralInstall(scriptPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(scriptPath)
}

/**
 * The Node.js pi's installer sets up lives in a versioned folder behind a `current` link
 * (~/.local/share/pi-node/current, %LOCALAPPDATA%\pi-node\current on Windows). process.execPath
 * resolves that link, so the IDE entry would break once pi installs a newer Node.js. Use the
 * link instead when it points at the running node.
 */
export function stableNodePath(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const current =
    platform === 'win32'
      ? env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'pi-node', 'current', 'node.exe')
      : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'pi-node', 'current', 'bin', 'node')
  if (!current) return execPath
  try {
    return realpathSync(current) === realpathSync(execPath) ? current : execPath
  } catch {
    return execPath
  }
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

/** Build the agent_servers entry: absolute node + script, so the IDE needs no PATH from the shell. */
export function buildEntry(opts: SetupOptions): Json {
  const platform = opts.platform ?? process.platform
  const sep = platform === 'win32' ? ';' : ':'
  const dirOf = platform === 'win32' ? (p: string) => p.replace(/[\\/][^\\/]*$/, '') : dirname
  const folders = uniq([
    dirOf(opts.nodePath),
    ...(opts.piPath ? [dirOf(opts.piPath)] : []),
    ...opts.basePath.split(sep)
  ])
  const env: Record<string, string> = { PATH: folders.join(sep) }
  if (opts.piPath) env.PIDEA_PI_COMMAND = opts.piPath

  return { command: opts.nodePath, args: [opts.scriptPath], env }
}

/** Merge the entry into an existing acp.json, keeping every other agent and the user's own settings. */
export function mergeConfig(existing: Json, name: string, entry: Json): Json {
  const out: Json = { ...existing }
  const mcp = (out.default_mcp_settings ?? {}) as Json
  out.default_mcp_settings = { use_idea_mcp: true, use_custom_mcp: true, ...mcp }
  const servers = { ...((out.agent_servers ?? {}) as Record<string, Json>) }
  const prev = servers[name] ?? {}
  servers[name] = {
    ...prev, // keeps idea_mcp_allowed_tools and any other custom keys
    ...entry,
    env: { ...((prev.env ?? {}) as Json), ...((entry.env ?? {}) as Json) }
  }
  out.agent_servers = servers
  return out
}

function findOnPath(names: string[], pathVar: string, platform: NodeJS.Platform): string | null {
  const sep = platform === 'win32' ? ';' : delimiter
  for (const folder of pathVar.split(sep)) {
    if (!folder) continue
    for (const name of names) {
      const candidate = join(folder, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function findPi(pathVar = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | null {
  return findOnPath(platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'], pathVar, platform)
}

function parseArgs(argv: string[]): { name: string; config: string; dryRun: boolean } {
  let name = DEFAULT_ENTRY_NAME
  let config = join(homedir(), '.jetbrains', 'acp.json')
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--name') name = argv[++i] ?? name
    else if (a === '--config') config = argv[++i] ?? config
    else throw new Error(`unknown option: ${a}\nusage: pidea setup [--dry-run] [--name <entry>] [--config <acp.json>]`)
  }
  return { name, config, dryRun }
}

export function runSetup(argv: string[]): number {
  const { name, config, dryRun } = parseArgs(argv)
  const scriptPath = fileURLToPath(import.meta.url)
  if (isEphemeralInstall(scriptPath)) {
    process.stderr.write(
      'pidea setup: running from the npx cache, which can be deleted at any time. Install the adapter first (see the README), then run `pidea setup`.\n'
    )
    return 1
  }
  const piPath = findPi()
  const nodePath = stableNodePath(process.execPath)

  let existing: Json = {}
  if (existsSync(config)) {
    try {
      existing = JSON.parse(readFileSync(config, 'utf8')) as Json
    } catch (e) {
      process.stderr.write(`pidea setup: ${config} is not valid JSON (${(e as Error).message}); not touching it.\n`)
      return 1
    }
  }

  const entry = buildEntry({
    nodePath,
    scriptPath,
    piPath,
    basePath: process.env.PATH ?? ''
  })
  const merged = mergeConfig(existing, name, entry)
  const text = JSON.stringify(merged, null, 2) + '\n'

  if (!piPath) {
    process.stderr.write(
      'pidea setup: warning: `pi` was not found on PATH. Install pi with its installer (https://pi.dev), then run setup again.\n'
    )
  }
  if (dryRun) {
    process.stdout.write(`${text}`)
    return 0
  }
  mkdirSync(dirname(config), { recursive: true })
  // Back up only once, so a second run never overwrites the user's original file with our own output.
  const bak = `${config}.bak`
  const backedUp = existsSync(config) && !existsSync(bak)
  if (backedUp) copyFileSync(config, bak)
  writeFileSync(config, text)
  process.stdout.write(
    `Wrote agent "${name}" to ${config}${backedUp ? ` (previous file saved as ${bak})` : ''}.\nnode: ${nodePath}\npi:   ${piPath ?? 'not found'}\nRestart the IDE, then pick "${name}" in the AI Chat.\n`
  )
  return 0
}
