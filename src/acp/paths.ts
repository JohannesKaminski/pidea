import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPideaDir(): string {
  return join(homedir(), '.pi', 'pidea')
}

export function getPideaSessionMapPath(): string {
  // The smoke matrix (and any host) may redirect the adapter-owned session map
  // away from the user store via PIDEA_SESSION_MAP.
  const override = process.env.PIDEA_SESSION_MAP
  return override ? resolve(override) : join(getPideaDir(), 'session-map.json')
}
