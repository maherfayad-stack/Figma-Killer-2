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
import { agentWriteRefusal } from './agentWriteScope'

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

describe('agentWriteRefusal — what an agent may not write', () => {
  it('refuses .studio/meta.json, the file that carries the trust tier', () => {
    const dir = tmpProject()
    const reason = agentWriteRefusal(join(dir, '.studio', 'meta.json'), dir)
    expect(reason?.code).toBe('protected-path')
    expect(reason?.message).toContain('.studio')
  })

  it('refuses a relative path, resolved against cwd', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal('.studio/meta.json', dir)).not.toBeNull()
  })

  it('refuses a traversal that arrives at the control plane the long way', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, 'src', '..', '.studio', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal('src/../.studio/meta.json', dir)).not.toBeNull()
  })

  it('refuses a case variant — the filesystem is case-insensitive on Windows', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.STUDIO', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.Claude', 'settings.local.json'), dir)).not.toBeNull()
  })

  it('refuses spellings Windows resolves to the control plane — trailing dot, trailing space, NTFS stream', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.studio.', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.claude ', 'settings.local.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.git::$INDEX_ALLOCATION', 'hooks', 'pre-commit'), dir)).not.toBeNull()
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
    expect(agentWriteRefusal(join(dir, 'src', 'run.sh'), dir)).not.toBeNull()
  })

  it('refuses .claude/, which holds the settings file wiring this very hook', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.claude', 'settings.local.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.claude', '.studio-generated.json'), dir)).not.toBeNull()
  })

  it('refuses .git/, where a planted hook runs on the user\'s next commit', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.git', 'hooks', 'pre-commit'), dir)).not.toBeNull()
  })

  it('refuses a nested control-plane directory, not only one at the project root', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, 'packages', 'app', '.studio', 'meta.json'), dir)).not.toBeNull()
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
    expect(agentWriteRefusal(join(dir, 'src', 'cfg', 'meta.json'), dir)).not.toBeNull()
  })

  it('allows the source files an agent actually authors', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, 'src', 'pages', 'Home.tsx'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'pages', 'Home.module.css'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'lib', 'format.ts'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'public', 'logo.svg'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'tsconfig.json'), dir)).toBeNull()
  })

  it('does not refuse a name that merely starts with a forbidden one', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'studio-notes.md'), '')
    expect(agentWriteRefusal(join(dir, '.studiorc'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'studio-notes.md'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'gitignore.ts'), dir)).toBeNull()
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

    expect(agentWriteRefusal(join(project, 'src', 'Home.tsx'), project)).toBeNull()
    expect(agentWriteRefusal(join(project, '.studio', 'meta.json'), project)).not.toBeNull()
  })

  it('leaves a path outside the project to the process boundary that already owns it', () => {
    // Not this predicate's job and deliberately not claimed: the CLI refuses a
    // write outside `cwd` + `--add-dir` before a hook is consulted at all.
    const dir = tmpProject()
    const elsewhere = tmpProject()
    expect(agentWriteRefusal(join(elsewhere, '.studio', 'meta.json'), dir)).toBeNull()
  })

  it('names .studio, .claude and .git — the escalation set, not a subset', () => {
    for (const name of ['.studio', '.claude', '.git', 'node_modules']) {
      expect(UNWRITABLE_WORKSPACE_DIR_NAMES.has(name), `${name} must be unwritable`).toBe(true)
    }
  })
})

describe('agentWriteRefusal — files that run on the host need the user (security review of #233, F3)', () => {
  // One case per class. The HTTP tools reach the same predicate through
  // agentFileAccess.ts; fileTools.test.ts proves that side, and the spawned
  // hook test in hooks/hooks.test.ts proves the CLI side end to end.
  const CLASSES: ReadonlyArray<readonly [string, string]> = [
    ['Node-executed build config', 'vite.config.ts'],
    ['the same, spelled the way Windows resolves it', 'Vite.Config.JS.'],
    ['a named-mode Vite config', 'vite.prod.config.mjs'],
    ['PostCSS config', 'postcss.config.cjs'],
    ['Tailwind config', 'tailwind.config.js'],
    ['a Babel rc file', '.babelrc'],
    ['the package manifest', 'package.json'],
    ['a nested package manifest', 'packages/app/package.json'],
    ['npm config', '.npmrc'],
    ['an env file', '.env.local'],
    ['a husky git hook', '.husky/pre-commit'],
    ['VS Code tasks', '.vscode/tasks.json'],
    ['a CI workflow', '.github/workflows/ci.yml'],
    ['bun config', 'bunfig.toml'],
    ['the root CLAUDE.md', 'CLAUDE.md'],
    ['a nested CLAUDE.md', 'pages/CLAUDE.md'],
  ]
  for (const [label, rel] of CLASSES) {
    it(`${label} (${rel}) refuses needs-user and says to ask the user`, () => {
      const dir = tmpProject()
      const refusal = agentWriteRefusal(join(dir, ...rel.split('/')), dir)
      expect(refusal?.code).toBe('needs-user')
      expect(refusal?.message).toContain('ask them to make or approve it')
    })
  }

  it('.git and .claude stay protected-path — the control plane Studio owns, not a user approval', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.git', 'hooks', 'pre-commit'), dir)?.code).toBe('protected-path')
    expect(agentWriteRefusal(join(dir, '.claude', 'settings.local.json'), dir)?.code).toBe('protected-path')
  })

  it('a segment that merely starts with two dots is inside the project (F9)', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '..foo', '.claude', 'x.json'), dir)?.code).toBe('protected-path')
  })
})
