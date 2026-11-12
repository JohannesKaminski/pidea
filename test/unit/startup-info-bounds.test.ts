import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStartupInfo } from '../../src/acp/agent.js'

test('buildStartupInfo bounds the skill inventory and survives symlink cycles', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pidea-inv-'))
  const skillsRoot = join(cwd, '.pi', 'skills')
  for (let i = 0; i < 400; i++) {
    const d = join(skillsRoot, `skill-${i}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), `# Skill ${i}\n`)
  }
  // A self-referential symlink cycle must terminate and not duplicate traversal.
  try {
    symlinkSync(skillsRoot, join(skillsRoot, 'cycle'))
  } catch {
    // symlinks unavailable (e.g. Windows without privileges)
  }

  const info = buildStartupInfo({ cwd, fileCommands: [] })
  assert.ok(info.length > 0, 'empty startup info')
  assert.ok(info.length <= 64_000, `startup info ${info.length} exceeds the 64 KB cap`)
})
