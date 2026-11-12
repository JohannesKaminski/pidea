// Packaging check: pack the npm tarball, install it into a clean temporary prefix (through
// scripts/install.sh on macOS and Linux, which also runs `pidea setup` against a temporary
// acp.json), and confirm the installed `pidea` starts and answers `initialize`. Catches anything that
// works only inside this repo, e.g. a runtime import of a devDependency such as
// pi-coding-agent (installs don't have it). Doesn't need pi: initialize never spawns it.
import crossSpawn from 'cross-spawn'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'pidea-pack-'))
// cross-spawn runs Windows .cmd launchers (npm, pidea), which Node refuses without a shell.
function run(command, args, cwd, env = process.env) {
  const result = crossSpawn.sync(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited with ${result.status}`)
}

function fail(message) {
  console.error(`FAIL check-pack: ${message}`)
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  process.exit(1)
}

try {
  // Pack (which builds via prepack) and find the tarball on disk. npm's stdout differs between
  // versions (npm 10 interleaves the build log even with --json), so it isn't parsed.
  run('npm', ['pack', '--pack-destination', work], root)
  const tarballName = readdirSync(work).find(name => name.endsWith('.tgz'))
  if (!tarballName) fail('npm pack produced no tarball')
  const tarball = join(work, tarballName)
  const prefix = join(work, 'prefix')
  const binDir = join(work, 'bin')
  const acpConfig = join(work, 'acp.json')
  const viaInstaller = process.platform !== 'win32'
  if (viaInstaller) {
    run('sh', [join(root, 'scripts', 'install.sh'), '--config', acpConfig], work, {
      ...process.env,
      PIDEA_TARBALL: tarball,
      PIDEA_PREFIX: prefix,
      PIDEA_BIN_DIR: binDir
    })
  } else {
    run('npm', ['install', '-g', '--prefix', prefix, tarball, '--no-audit', '--no-fund'], work)
  }

  const pkgDir =
    process.platform === 'win32' ? join(prefix, 'node_modules', 'pidea') : join(prefix, 'lib', 'node_modules', 'pidea')
  // Every built entry (adapter and bundled pi extensions) must be in the installed package.
  const extensions = readdirSync(join(root, 'dist', 'pi-extension')).filter(name => name.endsWith('.js'))
  for (const file of ['dist/index.js', ...extensions.map(name => `dist/pi-extension/${name}`)]) {
    if (!existsSync(join(pkgDir, file))) fail(`installed package is missing ${file}`)
  }

  if (viaInstaller) {
    const entry = JSON.parse(readFileSync(acpConfig, 'utf8')).agent_servers?.pidea
    // realpath: macOS's tmpdir is a symlink, and setup records the resolved path.
    if (entry?.args?.[0] !== realpathSync(join(pkgDir, 'dist', 'index.js')))
      fail(`install.sh did not run setup for the installed copy: ${JSON.stringify(entry)}`)
  }
  // The installer's launcher, which finds pi's Node.js even when it is not on PATH.
  const bin = viaInstaller ? join(binDir, 'pidea') : join(prefix, 'pidea.cmd')
  const child = crossSpawn(bin, [], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise(resolveExit => child.once('exit', resolveExit))
  const result = await new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`no initialize response within 15s; stderr:\n${stderr}`))
    }, 15_000)
    child.stdout.on('data', chunk => {
      stdout += chunk
      const line = stdout.split('\n').find(l => l.includes('"id":1'))
      if (line) {
        clearTimeout(timer)
        child.stdin.end()
        resolvePromise(JSON.parse(line))
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('exit', code => {
      clearTimeout(timer)
      if (!stdout.includes('"id":1'))
        reject(new Error(`pidea exited (code ${code}) before answering; stderr:\n${stderr}`))
    })
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n'
    )
  })
  // Let the adapter shut down (stdin closed) before removing its working directory: Windows
  // refuses to delete a directory a running process still uses.
  await Promise.race([exited, new Promise(r => setTimeout(r, 10_000))])
  if (result?.result?.protocolVersion !== 1) fail(`unexpected initialize response: ${JSON.stringify(result)}`)

  const how = viaInstaller ? 'install.sh' : 'npm install -g'
  console.log(`OK check-pack (${tarballName}: clean install via ${how} starts and answers initialize)`)
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
