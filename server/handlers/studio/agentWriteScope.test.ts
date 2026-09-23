/**
 * agentWriteScope — the native-write control-plane refusal (sec-12).
 *
 * Driven with the paths an escalation would actually use, not with the happy
 * spelling: the direct one, the traversal that arrives at the same file by a
 * longer route, the case variant that reaches it on a case-insensitive
 * filesystem, and the symlink a repository from GitHub can legitimately carry.
 * Each of those is a way to write `.studio/meta.json` — i.e. to promote the
 * project to Tier 2 without the user, which is the consent A10's second gate
 * is built on.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UNWRITABLE_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { agentWriteRefusalReason } from './agentWriteScope'

const created: string[] = []

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-agent-write-scope-'))
  created.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, '.studio'), { recursive: true })
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

describe('agentWriteRefusalReason — what an agent may not write', () => {
  it('refuses .studio/meta.json, the file that carries the trust tier', () => {
    const dir = tmpProject()
    const reason = agentWriteRefusalReason(join(dir, '.studio', 'meta.json'), dir)
    expect(reason).not.toBeNull()
    expect(reason).toContain('.studio')
  })

  it('refuses a relative path, resolved against cwd', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason('.studio/meta.json', dir)).not.toBeNull()
  })

  it('refuses a traversal that arrives at the control plane the long way', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, 'src', '..', '.studio', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusalReason('src/../.studio/meta.json', dir)).not.toBeNull()
  })

  it('refuses a case variant — the filesystem is case-insensitive on Windows', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, '.STUDIO', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusalReason(join(dir, '.Claude', 'settings.local.json'), dir)).not.toBeNull()
  })

  it('refuses spellings Windows resolves to the control plane — trailing dot, trailing space, NTFS stream', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, '.studio.', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusalReason(join(dir, '.claude ', 'settings.local.json'), dir)).not.toBeNull()
    expect(agentWriteRefusalReason(join(dir, '.git::$INDEX_ALLOCATION', 'hooks', 'pre-commit'), dir)).not.toBeNull()
  })

  it('refuses a write through a dangling symlink, which would land wherever it points', () => {
    const dir = tmpProject()
    const outside = mkdtempSync(join(tmpdir(), 'studio-agent-write-scope-outside-'))
    created.push(outside)
    try {
      symlinkSync(join(outside, 'payload.sh'), join(dir, 'src', 'run.sh'))
    } catch {
      return // unprivileged file symlinks are not always available on Windows
    }
    expect(agentWriteRefusalReason(join(dir, 'src', 'run.sh'), dir)).not.toBeNull()
  })

  it('refuses .claude/, which holds the settings file wiring this very hook', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, '.claude', 'settings.local.json'), dir)).not.toBeNull()
    expect(agentWriteRefusalReason(join(dir, '.claude', '.studio-generated.json'), dir)).not.toBeNull()
  })

  it('refuses .git/, where a planted hook runs on the user\'s next commit', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, '.git', 'hooks', 'pre-commit'), dir)).not.toBeNull()
  })

  it('refuses a nested control-plane directory, not only one at the project root', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, 'packages', 'app', '.studio', 'meta.json'), dir)).not.toBeNull()
  })

  it('refuses a symlink that merely LOOKS like source but resolves into the control plane', () => {
    const dir = tmpProject()
    try {
      symlinkSync(join(dir, '.studio'), join(dir, 'src', 'cfg'), 'dir')
    } catch {
      // Unprivileged symlink creation is not always available on Windows —
      // the textual cases above still cover the rest of the predicate.
      return
    }
    // Nothing in this spelling says `.studio`; only the resolved path does.
    expect(agentWriteRefusalReason(join(dir, 'src', 'cfg', 'meta.json'), dir)).not.toBeNull()
  })

  it('allows the source files an agent actually authors', () => {
    const dir = tmpProject()
    expect(agentWriteRefusalReason(join(dir, 'src', 'pages', 'Home.tsx'), dir)).toBeNull()
    expect(agentWriteRefusalReason(join(dir, 'src', 'pages', 'Home.module.css'), dir)).toBeNull()
    expect(agentWriteRefusalReason('package.json', dir)).toBeNull()
  })

  it('does not refuse a name that merely starts with a forbidden one', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'studio-notes.md'), '')
    expect(agentWriteRefusalReason(join(dir, '.studiorc'), dir)).toBeNull()
    expect(agentWriteRefusalReason(join(dir, 'studio-notes.md'), dir)).toBeNull()
    expect(agentWriteRefusalReason(join(dir, 'src', 'gitignore.ts'), dir)).toBeNull()
  })

  it('judges segments relative to the PROJECT, not over the absolute path', () => {
    // Studio's own checkout sits under `.claude/worktrees/<id>/` and under a
    // `.git`-bearing repo. An absolute-path scan refuses every write in a
    // project that merely lives somewhere so named, which is a dead product,
    // not a secure one.
    const outer = mkdtempSync(join(tmpdir(), 'studio-agent-write-scope-outer-'))
    created.push(outer)
    const project = join(outer, '.claude', 'worktrees', 'wt', 'demo-project')
    mkdirSync(join(project, 'src'), { recursive: true })

    expect(agentWriteRefusalReason(join(project, 'src', 'Home.tsx'), project)).toBeNull()
    expect(agentWriteRefusalReason(join(project, '.studio', 'meta.json'), project)).not.toBeNull()
  })

  it('leaves a path outside the project to the process boundary that already owns it', () => {
    // Not this predicate's job and deliberately not claimed: the CLI refuses a
    // write outside `cwd` + `--add-dir` before a hook is consulted at all.
    const dir = tmpProject()
    const elsewhere = tmpProject()
    expect(agentWriteRefusalReason(join(elsewhere, '.studio', 'meta.json'), dir)).toBeNull()
  })

  it('names .studio, .claude and .git — the escalation set, not a subset', () => {
    for (const name of ['.studio', '.claude', '.git', 'node_modules']) {
      expect(UNWRITABLE_WORKSPACE_DIR_NAMES.has(name), `${name} must be unwritable`).toBe(true)
    }
  })
})
