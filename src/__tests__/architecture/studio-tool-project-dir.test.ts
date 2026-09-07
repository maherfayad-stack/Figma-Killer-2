/**
 * Studio MCP tools must resolve their optional `dir` through
 * `resolveToolProjectDir(dirInput, ctx)`, never through the bare
 * `resolveProjectDir`.
 *
 * `resolveProjectDir(undefined)` answers with the first project in
 * ALPHABETICAL order. That was harmless while a workspace held one project and
 * silently wrong the moment it held two: an agent that omitted `dir` — which
 * it does by default, since every tool documents the parameter as optional —
 * read and wrote `untitled` while the human was looking at `untitled-2`. Every
 * call succeeded and returned real data about a project the user could not
 * see, which is indistinguishable from the agent "remembering" the wrong
 * workspace.
 *
 * `resolveToolProjectDir` closes it by defaulting to the turn's own open
 * project (`ctx.workspaceDir`) before falling back. This gate exists because
 * the failure is invisible in review: a bare `resolveProjectDir(dirInput)`
 * looks correct, type-checks, and passes every test that only ever has one
 * project on disk.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProjectDirOutsideWorkspaceError,
  resolveProjectDir,
} from '../../../server/handlers/studioProjects'
import {
  ProjectDirMismatchError,
  resolveToolProjectDir,
} from '../../../server/ai/mcp/tools/studio/resolveToolProjectDir'

const TOOLS_DIR = join(import.meta.dir, '../../../server/ai/mcp/tools/studio')

/** The resolver itself is the one legitimate caller — it is the wrapper. */
const ALLOWLIST = new Set(['resolveToolProjectDir.ts'])

function toolSourceFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !ALLOWLIST.has(name))
}

describe('Studio MCP tools resolve dir against the open workspace', () => {
  it('no tool module calls resolveProjectDir directly', () => {
    const offenders: string[] = []
    for (const name of toolSourceFiles()) {
      const source = readFileSync(join(TOOLS_DIR, name), 'utf8')
      // Word-boundary-anchored so `resolveToolProjectDir` never matches.
      if (/(?<![A-Za-z])resolveProjectDir\s*\(/.test(source)) offenders.push(name)
    }

    expect(offenders).toEqual([])
  })

  it('every resolveToolProjectDir call passes the tool context', () => {
    const offenders: string[] = []
    for (const name of toolSourceFiles()) {
      const source = readFileSync(join(TOOLS_DIR, name), 'utf8')
      for (const call of source.match(/resolveToolProjectDir\([^)]*\)/g) ?? []) {
        if (!/,\s*ctx\s*\)/.test(call)) offenders.push(`${name}: ${call}`)
      }
    }

    expect(offenders).toEqual([])
  })
})

/**
 * The containment half (W10). `resolveProjectDir` used to be a bare
 * `resolve()`, so any absolute path a client wrote was accepted verbatim on
 * the ~70 studio routes and every studio MCP tool that take a `dir`. These
 * cases pin the two refusals that closed it — escaping the workspace at all,
 * and a workspace-BOUND connector reaching sideways into a project its turn
 * is not about — because both are invisible in review: the permissive code
 * type-checked and passed every test that only ever had one project on disk.
 */
describe('resolveProjectDir containment', () => {
  const previousRoot = process.env.STUDIO_WORKSPACE_DIR
  let root = ''
  let projectA = ''
  let projectB = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-project-dir-'))
    projectA = join(root, 'alpha')
    projectB = join(root, 'beta')
    mkdirSync(join(projectA, 'pages'), { recursive: true })
    mkdirSync(join(projectB, 'pages'), { recursive: true })
    process.env.STUDIO_WORKSPACE_DIR = root
  })

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.STUDIO_WORKSPACE_DIR
    else process.env.STUDIO_WORKSPACE_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a project inside the workspace root', () => {
    expect(resolveProjectDir(projectA)).toBe(projectA)
  })

  it('accepts a project directory that does not exist yet (scaffold/import)', () => {
    const notYet = join(root, 'gamma')
    expect(resolveProjectDir(notYet)).toBe(notYet)
  })

  it('refuses an absolute path outside the workspace root', () => {
    expect(() => resolveProjectDir(join(tmpdir(), 'somewhere-else'))).toThrow(
      ProjectDirOutsideWorkspaceError,
    )
  })

  it('refuses a `..` escape that resolves outside the root', () => {
    expect(() => resolveProjectDir(join(projectA, '..', '..'))).toThrow(
      ProjectDirOutsideWorkspaceError,
    )
  })

  it('refuses a symlink inside the workspace that points out of it', () => {
    const escapeTarget = mkdtempSync(join(tmpdir(), 'studio-escape-'))
    const link = join(root, 'linked')
    symlinkSync(escapeTarget, link, 'dir')
    try {
      expect(() => resolveProjectDir(link)).toThrow(ProjectDirOutsideWorkspaceError)
    } finally {
      rmSync(link, { force: true })
      rmSync(escapeTarget, { recursive: true, force: true })
    }
  })

  it('a bound connector may name its own project', () => {
    expect(resolveToolProjectDir(projectA, { workspaceDir: projectA })).toBe(projectA)
  })

  it('a bound connector may NOT name a different project', () => {
    expect(() => resolveToolProjectDir(projectB, { workspaceDir: projectA })).toThrow(
      ProjectDirMismatchError,
    )
  })

  it('an unbound connector may still name any project inside the workspace', () => {
    expect(resolveToolProjectDir(projectB, {})).toBe(projectB)
  })
})
