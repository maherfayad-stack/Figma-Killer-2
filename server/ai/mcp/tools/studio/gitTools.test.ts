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

const tool = studioGitMcpTools[0]!

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
    expect(tool.mutates).toBe(true)
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

  it('refuses a directory outside the workspace', async () => {
    const result = (await tool.handler(
      { dir: '/etc', message: 'x', files: ['passwd'] },
      context(dir),
    )) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('outside-workspace')
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
