import crossSpawn from 'cross-spawn'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInfo } from './build-info.js'
import { compareSemver } from './semver.js'
import { isEphemeralInstall } from './setup.js'

export interface Release {
  version: string
  tarballUrl: string
}

export interface UpdateDeps {
  installedVersion: string
  /** Path of the running adapter script. */
  scriptPath: string
  platform?: NodeJS.Platform
  latestRelease: () => Promise<Release>
  /** `npm install --global --prefix <prefix> <tarball>`. */
  npmInstall: (tarballUrl: string, prefix: string) => { status: number | null; stderr: string }
  out: (text: string) => void
}

const LATEST_RELEASE_URL = 'https://api.github.com/repos/JohannesKaminski/pidea/releases/latest'

/** Latest published GitHub release (drafts and prereleases are excluded by the endpoint). */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<Release> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pidea' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${LATEST_RELEASE_URL}`)
  const body = (await response.json()) as {
    tag_name?: string
    assets?: { name?: string; browser_download_url?: string }[]
  }
  const version = String(body.tag_name ?? '').replace(/^v/, '')
  const asset = body.assets?.find(a => a.name?.endsWith('.tgz'))
  if (!asset?.browser_download_url) throw new Error(`release ${body.tag_name} has no .tgz asset`)
  return { version, tarballUrl: asset.browser_download_url }
}

/**
 * The npm prefix pidea was installed into, read from the running script's path:
 * <prefix>/lib/node_modules/pidea/dist/index.js, or <prefix>\node_modules\pidea\dist\index.js on
 * Windows. That covers npm's global folder and the installer's ~/.pi/pidea alike. Null when
 * pidea runs from somewhere else, such as a source checkout.
 */
export function installPrefix(scriptPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const match =
    platform === 'win32'
      ? /^(.+)[\\/]node_modules[\\/]pidea[\\/]dist[\\/][^\\/]+$/.exec(scriptPath)
      : /^(.+)\/lib\/node_modules\/pidea\/dist\/[^/]+$/.exec(scriptPath)
  return match ? match[1] : null
}

/** The real environment: the npm next to the running node, which may not be on PATH (pi's own Node.js). */
export function defaultUpdateDeps(): UpdateDeps {
  const nodeDir = dirname(process.execPath)
  const bundled = join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const npm = existsSync(bundled) ? bundled : 'npm'
  return {
    installedVersion: buildInfo.packageVersion,
    scriptPath: fileURLToPath(import.meta.url),
    latestRelease: () => fetchLatestRelease(),
    npmInstall: (url, prefix) => {
      const result = crossSpawn.sync(npm, ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', url], {
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'pipe'],
        // npm's launcher starts with `#!/usr/bin/env node`, so the running node has to be on PATH
        // (npm.cmd on Windows calls the node.exe next to it).
        env:
          process.platform === 'win32'
            ? process.env
            : { ...process.env, PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}` }
      })
      return { status: result.status, stderr: String(result.stderr ?? '') }
    },
    out: text => process.stdout.write(text)
  }
}

export async function runUpdate(argv: string[], deps: UpdateDeps): Promise<number> {
  let latest: Release
  try {
    latest = await deps.latestRelease()
  } catch (e) {
    deps.out(`pidea update: could not look up the latest release: ${(e as Error).message}\n`)
    return 1
  }
  const newer = compareSemver(latest.version, deps.installedVersion) > 0
  deps.out(`installed: ${deps.installedVersion}\nlatest:    ${latest.version}\n`)
  if (!newer) {
    deps.out('pidea is up to date.\n')
    return 0
  }
  if (argv.includes('--check')) {
    deps.out(`pidea ${latest.version} is available. Run \`pidea update\` to install it.\n`)
    return 0
  }
  if (isEphemeralInstall(deps.scriptPath)) {
    deps.out(
      'pidea update: running from the npx cache, which can be deleted at any time. Install pidea as described in the README instead.\n'
    )
    return 1
  }
  const prefix = installPrefix(deps.scriptPath, deps.platform)
  if (!prefix) {
    deps.out(
      `pidea update: ${deps.scriptPath} was not installed with npm (a source checkout?), so there is nothing to update. Install pidea as described in the README.\n`
    )
    return 1
  }
  deps.out(`Installing ${latest.tarballUrl} into ${prefix}\n`)
  const result = deps.npmInstall(latest.tarballUrl, prefix)
  if (result.status !== 0) {
    deps.out(`pidea update: npm install failed:\n${result.stderr}`)
    if (result.stderr.includes('EACCES')) {
      // Never escalate with sudo; point at the two fixes npm documents instead.
      deps.out(
        `\nnpm may not write to ${prefix}. Don't use sudo: on macOS and Linux, reinstall pidea with the installer from the README, which installs into your home folder. Otherwise install Node.js with a version manager such as nvm.\nhttps://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally\n`
      )
    }
    return 1
  }
  deps.out(`Installed pidea ${latest.version}. Restart the IDE to use pidea ${latest.version}.\n`)
  return 0
}
