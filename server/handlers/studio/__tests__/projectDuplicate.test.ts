/**
 * projectDuplicate — unit tests for copying a whole project.
 *
 * Three properties carry the weight here. The copy must be a real, complete
 * project (source + the `.studio/` sidecar, or opening it produces a board
 * with no frames). It must NOT carry the four directories that would make it
 * either enormous or dangerous — `node_modules`, build output, and above all
 * `.git`, whose remote belongs to the original. And it must not end up with
 * the original's display name, which would put two identically-named tiles in
 * the launcher with no way to tell them apart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listStudioProjects } from '../../studioProjects'
import { ProjectDuplicateError, duplicateStudioProject } from '../projectDuplicate'
import { readStudioMeta, writeStudioMeta } from '../studioMeta'
import { PROJECTS_TRASH_DIR_NAME } from '../projectTrash'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-duplicate-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function makeProject(folder: string, displayName?: string): string {
  const dir = path.join(root, folder)
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() { return <div /> }\n')
  // A real `package.json`, because `generateStudioProjectGuide` heals a
  // project that has none by applying the design-system SEED — which writes
  // `node_modules/@alm-design` into the target. That is correct behaviour for
  // a project with no manifest, and it would make the "nothing regenerable was
  // copied" case below assert the seed rather than the filter.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: folder, dependencies: {} }))
  if (displayName) writeStudioMeta(dir, { displayName })
  return dir
}

describe('duplicateStudioProject', () => {
  it('copies the source tree, the .studio sidecar included', () => {
    const dir = makeProject('acme')
    writeStudioMeta(dir, { displayName: 'Acme', frameDefaults: { width: 390, height: 844 } })

    const copy = duplicateStudioProject(root, dir)

    expect(fs.existsSync(path.join(copy.dir, 'pages', 'Home.tsx'))).toBe(true)
    // The sidecar is the board: frame defaults, boards, trust tier. A copy
    // without it opens as an empty canvas.
    expect(readStudioMeta(copy.dir).frameDefaults).toEqual({ width: 390, height: 844 })
    // The original is untouched — this is a copy, not a move.
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('leaves node_modules, build output and .git behind', () => {
    const dir = makeProject('acme')
    for (const skipped of ['node_modules', 'dist', '.next', '.turbo', '.git']) {
      fs.mkdirSync(path.join(dir, skipped), { recursive: true })
      fs.writeFileSync(path.join(dir, skipped, 'marker'), 'x')
    }

    const copy = duplicateStudioProject(root, dir)

    for (const skipped of ['node_modules', 'dist', '.next', '.turbo', '.git']) {
      expect([skipped, fs.existsSync(path.join(copy.dir, skipped))]).toEqual([skipped, false])
    }
  })

  it('names the copy "<name> copy", then "<name> copy 2", never the original name', () => {
    const dir = makeProject('acme', 'Acme')

    const first = duplicateStudioProject(root, dir)
    const second = duplicateStudioProject(root, dir)

    expect(first.name).toBe('Acme copy')
    expect(second.name).toBe('Acme copy 2')
    // The DISPLAY name is what the launcher sorts and renders, so it is what
    // has to be free — the folder slug follows from it.
    expect(listStudioProjects(root).map((p) => p.name)).toEqual(['Acme', 'Acme copy', 'Acme copy 2'])
  })

  it('uses an explicit name verbatim, with no " copy" suffix', () => {
    const dir = makeProject('acme', 'Acme')

    const copy = duplicateStudioProject(root, dir, '  Acme staging  ')

    expect(copy.name).toBe('Acme staging')
    expect(readStudioMeta(copy.dir).displayName).toBe('Acme staging')
  })

  it('refuses an explicit name another project already answers to', () => {
    const dir = makeProject('acme', 'Acme')
    makeProject('beta', 'Beta')

    expect(() => duplicateStudioProject(root, dir, 'Beta')).toThrow(ProjectDuplicateError)
    try {
      duplicateStudioProject(root, dir, 'Beta')
    } catch (err) {
      expect((err as ProjectDuplicateError).reason).toBe('name-taken')
    }
  })

  it('clears lastOpenedAt — nobody has opened the copy', () => {
    const dir = makeProject('acme', 'Acme')
    writeStudioMeta(dir, { displayName: 'Acme', lastOpenedAt: 1_700_000_000_000 })

    const copy = duplicateStudioProject(root, dir)

    expect(readStudioMeta(copy.dir).lastOpenedAt).toBeUndefined()
    expect(readStudioMeta(dir).lastOpenedAt).toBe(1_700_000_000_000)
  })

  it('writes a project guide into the copy', () => {
    const dir = makeProject('acme', 'Acme')

    const copy = duplicateStudioProject(root, dir)

    // Regenerated rather than inherited: the source's guide names the source.
    expect(fs.existsSync(path.join(copy.dir, 'CLAUDE.md'))).toBe(true)
  })

  it('refuses a path that is not an immediate child of the workspace', () => {
    const dir = makeProject('acme')

    for (const bad of [path.join(dir, 'pages'), root, path.join(root, '..', 'elsewhere')]) {
      expect(() => duplicateStudioProject(root, bad)).toThrow(ProjectDuplicateError)
    }
  })

  it('refuses the trash', () => {
    fs.mkdirSync(path.join(root, PROJECTS_TRASH_DIR_NAME), { recursive: true })

    expect(() => duplicateStudioProject(root, path.join(root, PROJECTS_TRASH_DIR_NAME)))
      .toThrow(ProjectDuplicateError)
  })

  it('reports not-found for a project that is already gone', () => {
    try {
      duplicateStudioProject(root, path.join(root, 'ghost'))
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectDuplicateError)
      expect((err as ProjectDuplicateError).reason).toBe('not-found')
    }
  })
})
