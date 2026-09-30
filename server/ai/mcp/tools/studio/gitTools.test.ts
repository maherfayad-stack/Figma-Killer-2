/**
 * `studio_git_commit` — the agent-facing commit tool.
 *
 * The capability declaration is tested as hard as the behaviour, because it is
 * the whole safety story: a tool that quietly rode `studio.write` would be
 * granted to every Admin and every connector that can edit a project at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../../../handlers/studioProjects'
import { toolAllowedForCapabilities } from '../../../tools/capabilityGate'
import { studioGitMcpTools } from './gitTools'
import type { ToolContext } from '../../../runtime/types'

/**
 * Looked up BY NAME, not by index. The family grew from one tool to five in
 * G6; an index would have silently re-pointed every assertion below at a
 * different tool and still gone green on some of them.
 */
const tool = studioGitMcpTools.find((entry) => entry.name === 'studio_git_commit')!

/**
 * The fixture projects live in a REAL temp workspace, not in the developer's
 * own `studio-workspace/`: the tool's guard only accepts a directory under
 * `projectsRootDir()`, and pointing that at the checkout meant every run
 * planted `__git_tool_test_*` folders the launcher listed as real projects —
 * permanently, whenever a run was killed before `afterAll`. `realpathSync`
 * because macOS's `/var/folders/…` tmpdir is a symlink and the guard resolves
 * real paths on both sides.
 */
const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-tool-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR

beforeAll(() => {
  process.env.STUDIO_WORKSPACE_DIR = workspaceRoot
})

afterAll(() => {
  // Restored, not just deleted: `bun test` runs files in one process per
  // worker, so leaving it set would relocate the workspace for whatever file
  // runs next.
  if (priorWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = priorWorkspaceDir
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  await new Response(proc.stdout).text()
  await new Response(proc.stderr).text()
  return proc.exited
}

/** One fixture project inside the temp workspace — `projectsRootDir()` is what the guard checks, so the test asks it rather than rebuilding the path. */
function makeProject(): string {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, 'project_'))
}

async function makeRepo(dir: string): Promise<void> {
  await git(dir, ['init', '--initial-branch=main'])
  await git(dir, ['config', 'user.email', 'agent-test@example.com'])
  await git(dir, ['config', 'user.name', 'Agent Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  // Clears the helper list. Without it, `studio_git_push`'s network call
  // invokes the host's credential helper — Git Credential Manager on Windows,
  // which opens a GUI dialog and blocks for the full network timeout. The
  // remote below is a local bare repository, so no helper is needed.
  await git(dir, ['config', 'credential.helper', ''])
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return null }\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'Initial commit'])
}

/** The tool reads only `workspaceDir` off the context. */
function context(dir: string): ToolContext {
  return { workspaceDir: dir } as unknown as ToolContext
}

describe('studio_git_commit — capability declaration', () => {
  it('requires studio.git.write, not studio.write', () => {
    expect(tool.requiredCapabilities).toEqual(['studio.git.write'])
  })

  it('is invisible to a connector that can edit studio projects but was not granted commit', () => {
    expect(toolAllowedForCapabilities(tool, ['ai.chat', 'ai.tools.write', 'studio.write'])).toBe(false)
  })

  it('is invisible without ai.tools.write, because it mutates', () => {
    expect(tool.requiresWrite).toBe(true)
    expect(toolAllowedForCapabilities(tool, ['ai.chat', 'studio.git.write'])).toBe(false)
  })

  it('is visible only when BOTH axes are held', () => {
    expect(toolAllowedForCapabilities(tool, ['ai.chat', 'ai.tools.write', 'studio.git.write'])).toBe(true)
  })
})

describe('studio_git_commit — behaviour', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProject()
    await makeRepo(dir)
  })

  it('commits exactly the named files', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <b/> }\n')
    fs.writeFileSync(path.join(dir, 'pages', 'Other.tsx'), 'export default function Other() { return null }\n')

    const result = (await tool.handler(
      { dir, message: 'Bold the home page', files: ['pages/Home.tsx'] },
      context(dir),
    )) as { ok: boolean; files: string[]; sha: string }

    expect(result.ok).toBe(true)
    expect(result.files).toEqual(['pages/Home.tsx'])

    // Other.tsx was NOT swept in — the whole point of naming files.
    const proc = Bun.spawn(['git', 'show', '--name-only', '--format=', 'HEAD'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const committed = await new Response(proc.stdout).text()
    await proc.exited
    expect(committed).toContain('pages/Home.tsx')
    expect(committed).not.toContain('pages/Other.tsx')
  })

  it.each([
    ['traversal', '../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['an excluded directory', 'node_modules/left-pad/index.js'],
    ['Studio\'s own sidecar', '.studio/meta.json'],
  ])('refuses %s without committing anything', async (_label, badPath) => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'changed\n')
    const before = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()

    const result = (await tool.handler(
      { dir, message: 'sneak', files: ['pages/Home.tsx', badPath] },
      context(dir),
    )) as { ok: boolean; code: string }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-path')
    expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()).toBe(before)
  })

  it('refuses a project with no repository of its own, and says the agent may not create one', async () => {
    const bare = makeProject()
    fs.writeFileSync(path.join(bare, 'App.tsx'), 'export const App = () => null\n')

    const result = (await tool.handler(
      { dir: bare, message: 'first', files: ['App.tsx'] },
      context(bare),
    )) as { ok: boolean; code: string; error: string }

    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-a-repository')
    expect(result.error).toContain('may not create it yourself')
  })

  it('refuses a blank message', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'changed\n')
    const result = (await tool.handler(
      { dir, message: '   ', files: ['pages/Home.tsx'] },
      context(dir),
    )) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-message')
  })
})
// ---------------------------------------------------------------------------
// The rest of the family (G6)
// ---------------------------------------------------------------------------

function toolNamed(name: string) {
  const found = studioGitMcpTools.find((entry) => entry.name === name)
  if (!found) throw new Error(`no such git tool: ${name}`)
  return found
}

const statusTool = toolNamed('studio_git_status')
const branchTool = toolNamed('studio_git_branch')
const pushTool = toolNamed('studio_git_push')
const openPrTool = toolNamed('studio_git_open_pr')

/**
 * The capability declarations ARE the safety story for this family — a tool
 * that quietly rode `studio.write` would be handed to every Admin and every
 * connector that can edit a project at all. So each one is asserted, not
 * assumed.
 */
describe('the git tool family — capability declarations', () => {
  it('gates every MUTATING tool behind studio.git.write, never studio.write', () => {
    for (const mutating of [branchTool, pushTool, openPrTool, toolNamed('studio_git_commit')]) {
      expect({ name: mutating.name, caps: mutating.requiredCapabilities, requiresWrite: mutating.requiresWrite }).toEqual({
        name: mutating.name,
        caps: ['studio.git.write'],
        requiresWrite: true,
      })
      expect(toolAllowedForCapabilities(mutating, ['ai.chat', 'ai.tools.write', 'studio.write'])).toBe(false)
      expect(toolAllowedForCapabilities(mutating, ['ai.chat', 'studio.git.write'])).toBe(false)
      expect(toolAllowedForCapabilities(mutating, ['ai.chat', 'ai.tools.write', 'studio.git.write'])).toBe(true)
    }
  })

  it('leaves studio_git_status as an ordinary read — reporting what you changed must not require permission to commit it', () => {
    expect(statusTool.requiresWrite ?? false).toBe(false)
    expect(statusTool.sideEffects).toBe('none')
    expect(statusTool.requiredCapabilities ?? []).toEqual([])
    expect(toolAllowedForCapabilities(statusTool, ['ai.chat'])).toBe(true)
  })

  it('offers no init, restore, pull or conflict tool — those are the ones only a human should drive', () => {
    expect(studioGitMcpTools.map((entry) => entry.name).sort()).toEqual([
      'studio_git_branch',
      'studio_git_commit',
      'studio_git_open_pr',
      'studio_git_push',
      'studio_git_status',
    ])
  })
})

/**
 * `guardProject` — the one guard all five tools share.
 *
 * `sec-13` filed its `outside-workspace` branch as dead on the grounds that
 * `resolveToolProjectDir` throws first. It does throw first for a `dir`
 * OUTSIDE the workspace — which is why the guard catches that throw — but the
 * branch is still reachable, because `resolveProjectDir` accepts the workspace
 * ROOT (and returns it when no `dir` is given and the workspace holds no
 * projects), and the root is not a project. Both paths are driven here, so the
 * next person to call the branch dead has to explain these two tests.
 */
describe('the git tool family — the shared project guard', () => {
  const allTools = [statusTool, branchTool, pushTool, openPrTool, toolNamed('studio_git_commit')]

  /** Minimal valid arguments per tool, so the guard is what refuses and not the schema. */
  function argsFor(name: string, dir: string): Record<string, unknown> {
    if (name === 'studio_git_commit') return { dir, message: 'x', files: ['pages/Home.tsx'] }
    if (name === 'studio_git_branch') return { dir, action: 'list' }
    if (name === 'studio_git_open_pr') return { dir, title: 'x' }
    return { dir }
  }

  it.each(allTools.map((entry) => [entry.name] as const))(
    '%s refuses a directory outside the workspace with a structured refusal, never a thrown exception',
    async (name) => {
      const outside = path.parse(workspaceRoot).root
      const result = (await toolNamed(name).handler(argsFor(name, outside), context(makeProject()))) as {
        ok: boolean
        code: string
        error: string
        retryable: boolean
      }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('outside-workspace')
      // A14: the code is rendered into `error` too, because every driver
      // reduces a failed tool result to that string.
      expect(result.error).toContain('[code=outside-workspace retryable=false]')
      expect(result.retryable).toBe(false)
    },
  )

  it('refuses the workspace ROOT itself — reached past the containment check, not by the catch above it', async () => {
    const result = (await statusTool.handler({ dir: workspaceRoot }, context(workspaceRoot))) as {
      ok: boolean
      code: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('outside-workspace')
  })

  it('lets a bound connector naming a DIFFERENT project fail with the mismatch message, not as "not a Studio project"', async () => {
    // Deliberately a throw, exactly as in every other Studio tool: the
    // message names both projects and the next action, and flattening it into
    // `outside-workspace` told the agent a project that exists does not.
    const turnProject = makeProject()
    const otherProject = makeProject()
    await expect(
      statusTool.handler({ dir: otherProject }, context(turnProject)),
    ).rejects.toThrow(/cannot operate on/)
  })
})

describe('studio_git_status', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProject()
    await makeRepo(dir)
  })

  it('reports the branch and the changed files, and withholds excluded paths', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'changed\n')
    fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

    const result = (await statusTool.handler({ dir }, context(dir))) as {
      ok: boolean
      isRepo: boolean
      branch: { branch: string | null }
      entries: Array<{ path: string }>
      excludedCount: number
      hasOrigin: boolean
    }

    expect(result.ok).toBe(true)
    expect(result.isRepo).toBe(true)
    expect(result.branch.branch).toBe('main')
    expect(result.entries.map((entry) => entry.path)).toEqual(['pages/Home.tsx'])
    expect(result.excludedCount).toBeGreaterThan(0)
    expect(result.hasOrigin).toBe(false)
  })

  it('answers isRepo:false for a project with no repository — a state an agent can report, not a failure', async () => {
    const bare = makeProject()
    fs.writeFileSync(path.join(bare, 'App.tsx'), 'export const App = () => null\n')

    const result = (await statusTool.handler({ dir: bare }, context(bare))) as { ok: boolean; isRepo: boolean }
    expect(result).toEqual({ ok: true, isRepo: false })
  })
})

describe('studio_git_branch', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProject()
    await makeRepo(dir)
  })

  it('lists branches with the current one marked', async () => {
    await git(dir, ['branch', 'feat/sidebar'])
    const result = (await branchTool.handler({ dir, action: 'list' }, context(dir))) as {
      ok: boolean
      branches: Array<{ name: string; current: boolean }>
      current: string | null
    }
    expect(result.ok).toBe(true)
    expect(result.current).toBe('main')
    expect(result.branches.map((b) => b.name).sort()).toEqual(['feat/sidebar', 'main'])
  })

  it('creates a branch at HEAD even with uncommitted work — moving a pointer cannot lose a byte', async () => {
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'work in progress\n')

    const result = (await branchTool.handler({ dir, action: 'create', name: 'feat/sidebar' }, context(dir))) as {
      ok: boolean
      branch: string
      created: boolean
    }
    expect(result).toMatchObject({ ok: true, branch: 'feat/sidebar', created: true })
    // The uncommitted work came with it.
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('work in progress')
  })

  it('refuses to switch over a dirty tree and names the files — Studio never stashes', async () => {
    await git(dir, ['branch', 'feat/other'])
    fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'uncommitted\n')

    const result = (await branchTool.handler({ dir, action: 'switch', name: 'feat/other' }, context(dir))) as {
      ok: boolean
      code: string
      dirtyFiles: string[]
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('dirty-tree')
    expect(result.dirtyFiles).toContain('pages/Home.tsx')
  })

  it('refuses a branch name that would be read as a flag, and a missing one', async () => {
    const flagLike = (await branchTool.handler({ dir, action: 'create', name: '--force' }, context(dir))) as {
      ok: boolean
      code: string
    }
    expect(flagLike).toMatchObject({ ok: false, code: 'invalid-branch-name' })

    const missing = (await branchTool.handler({ dir, action: 'create' }, context(dir))) as {
      ok: boolean
      code: string
    }
    expect(missing).toMatchObject({ ok: false, code: 'invalid-branch-name' })
  })

  it('refuses a project with no repository rather than reaching Studio\'s own', async () => {
    const bare = makeProject()
    const result = (await branchTool.handler({ dir: bare, action: 'list' }, context(bare))) as {
      ok: boolean
      code: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not-a-repository' })
  })
})

describe('studio_git_push', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProject()
    await makeRepo(dir)
  })

  it('pushes the current branch to a LOCAL BARE REMOTE — real transport, no network', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-tool-remote-'))
    try {
      await git(remote, ['init', '--bare', '--initial-branch=main'])
      await git(dir, ['remote', 'add', 'origin', remote])

      const result = (await pushTool.handler({ dir }, context(dir))) as { ok: boolean; branch: string }
      expect(result).toMatchObject({ ok: true, branch: 'main' })

      const proc = Bun.spawn(['git', 'log', '--format=%s', 'main'], { cwd: remote, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const log = await new Response(proc.stdout).text()
      await proc.exited
      expect(log).toContain('Initial commit')
    } finally {
      fs.rmSync(remote, { recursive: true, force: true })
    }
  })

  it('refuses with no origin rather than inventing one', async () => {
    const result = (await pushTool.handler({ dir }, context(dir))) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: 'no-origin-remote' })
  })
})

describe('studio_git_open_pr', () => {
  let dir: string

  beforeEach(async () => {
    dir = makeProject()
    await makeRepo(dir)
  })

  it('refuses a non-GitHub origin without naming it', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-tool-notgh-'))
    try {
      await git(remote, ['init', '--bare', '--initial-branch=main'])
      await git(dir, ['remote', 'add', 'origin', remote])

      const result = (await openPrTool.handler({ dir }, context(dir))) as { ok: boolean; code: string; error: string }
      expect(result).toMatchObject({ ok: false, code: 'not-a-github-remote' })
      expect(result.error).not.toContain(remote)
    } finally {
      fs.rmSync(remote, { recursive: true, force: true })
    }
  })

  it('refuses a PR from the base branch onto itself and says how to fix it', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    const result = (await openPrTool.handler({ dir }, context(dir))) as {
      ok: boolean
      code: string
      error: string
      compareUrl: string
    }
    expect(result).toMatchObject({ ok: false, code: 'same-branch' })
    expect(result.error).toContain('studio_git_branch')
    expect(result.compareUrl).toContain('/compare/main...main')
  })

  it('answers no-github-token WITH the compare URL — nobody is signed in on this server', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    await git(dir, ['switch', '--create', 'feat/sidebar'])

    const result = (await openPrTool.handler({ dir }, context(dir))) as {
      ok: boolean
      code: string
      compareUrl: string
    }
    expect(result).toMatchObject({
      ok: false,
      code: 'no-github-token',
      compareUrl: 'https://github.com/acme/storefront/compare/main...feat/sidebar?expand=1',
    })
  })

  it('refuses a project with no repository', async () => {
    const bare = makeProject()
    const result = (await openPrTool.handler({ dir: bare }, context(bare))) as { ok: boolean; code: string }
    expect(result).toMatchObject({ ok: false, code: 'not-a-repository' })
  })

  /**
   * `base` reaches an argv token (`origin/<base>..<head>` in
   * `readBranchCommitSubjects`). The `origin/` prefix stops it posing as a
   * flag, but the HTTP route puts it through `isArgvSafeBranchName` anyway and
   * this path must make the same judgement — a tool argument is no more
   * trusted than a request body just because an agent wrote it.
   */
  it('refuses a base branch the argv guard rejects — same judgement the HTTP route makes', async () => {
    await git(dir, ['remote', 'add', 'origin', 'https://github.com/acme/storefront.git'])
    await git(dir, ['switch', '--create', 'feat/sidebar'])

    for (const base of ['--force', '-x', 'main\nnot-main', 'a'.repeat(256)]) {
      const result = (await openPrTool.handler({ dir, base }, context(dir))) as { ok: boolean; code: string }
      expect({ base, ...result }).toMatchObject({ base, ok: false, code: 'invalid-branch-name' })
    }
  })
})
