/**
 * `acquireReadOnlyWorkspaceProject` — the reuse contract.
 *
 * The perf half (a ~3.0 s resync after a page edit down to ~0.4 s on a
 * 64-source-file project) is a benchmark number, not a test: a timing
 * assertion in a shared runner is a flake generator. What is tested here is
 * the only thing that can actually break, and it is the thing this product
 * cannot get wrong — a reused project must never hand back source text that a
 * freshly built one would not have. Every case below is a way the workspace
 * can change underneath a cached project.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireReadOnlyWorkspaceProject, clearReadOnlyWorkspaceProject } from '../componentSources'

const dirs: string[] = []

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ro-workspace-'))
  dirs.push(dir)
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents)
  }
  return dir
}

/** The text the project currently believes `rel` holds, or null when it holds no such file. */
function textOf(dir: string, rel: string): string | null {
  const project = acquireReadOnlyWorkspaceProject(dir)
  return project.getSourceFile(join(dir, ...rel.split('/')))?.getFullText() ?? null
}

afterEach(() => {
  clearReadOnlyWorkspaceProject()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('acquireReadOnlyWorkspaceProject', () => {
  it('serves the same project instance for the same root — the reuse actually happens', () => {
    const dir = workspace({ 'src/App.tsx': 'export const App = () => null\n' })
    expect(acquireReadOnlyWorkspaceProject(dir)).toBe(acquireReadOnlyWorkspaceProject(dir))
  })

  it('an EDITED file is re-read — a cached project never serves stale source', () => {
    const dir = workspace({ 'src/App.tsx': 'export const App = () => null\n' })
    expect(textOf(dir, 'src/App.tsx')).toContain('=> null')

    writeFileSync(join(dir, 'src', 'App.tsx'), 'export const App = () => "edited"\n')
    expect(textOf(dir, 'src/App.tsx')).toContain('"edited"')
  })

  it('an ADDED file appears without a restart', () => {
    const dir = workspace({ 'src/App.tsx': 'export const App = () => null\n' })
    acquireReadOnlyWorkspaceProject(dir)

    writeFileSync(join(dir, 'src', 'Later.tsx'), 'export const Later = () => null\n')
    expect(textOf(dir, 'src/Later.tsx')).toContain('Later')
  })

  it('a DELETED file is forgotten', () => {
    const dir = workspace({
      'src/App.tsx': 'export const App = () => null\n',
      'src/Gone.tsx': 'export const Gone = () => null\n',
    })
    expect(textOf(dir, 'src/Gone.tsx')).toContain('Gone')

    unlinkSync(join(dir, 'src', 'Gone.tsx'))
    expect(textOf(dir, 'src/Gone.tsx')).toBeNull()
  })

  it('an UNSAVED in-memory edit is discarded on the next checkout', () => {
    // The property that makes reuse safe rather than merely fast. A caller that
    // mutates the AST and never saves must not leave that mutation where the
    // next read can see it as if it were the user's source.
    const dir = workspace({ 'src/App.tsx': 'export const App = () => null\n' })
    const project = acquireReadOnlyWorkspaceProject(dir)
    project.getSourceFile(join(dir, 'src', 'App.tsx'))!.replaceWithText('export const App = () => "ghost"\n')

    expect(textOf(dir, 'src/App.tsx')).toContain('=> null')
    expect(textOf(dir, 'src/App.tsx')).not.toContain('ghost')
  })

  it('switching projects replaces the entry rather than mixing two workspaces', () => {
    const first = workspace({ 'src/First.tsx': 'export const First = () => null\n' })
    const second = workspace({ 'src/Second.tsx': 'export const Second = () => null\n' })

    expect(textOf(first, 'src/First.tsx')).toContain('First')
    expect(textOf(second, 'src/Second.tsx')).toContain('Second')
    expect(acquireReadOnlyWorkspaceProject(second).getSourceFile(join(first, 'src', 'First.tsx'))).toBeUndefined()
  })

  it('never adds `node_modules` — the exclusions are the same ones a fresh project uses', () => {
    const dir = workspace({
      'src/App.tsx': 'export const App = () => null\n',
      'node_modules/pkg/index.js': 'module.exports = {}\n',
    })
    expect(textOf(dir, 'node_modules/pkg/index.js')).toBeNull()
  })
})
