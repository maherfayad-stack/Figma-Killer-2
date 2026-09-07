/**
 * projectTrash — unit tests for deleting a whole project.
 *
 * The properties worth protecting are the destructive ones. Every case below
 * is either "the files still exist somewhere" or "a path that is not a project
 * is refused", because the failure mode this module exists to prevent is
 * losing a repository the user has no other copy of.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listStudioProjects } from '../../studioProjects'
import { PROJECTS_TRASH_DIR_NAME } from '../projectDirGuard'
import {
  ProjectTrashError,
  listTrashedProjects,
  parseTrashEntryName,
  purgeTrashedProject,
  restoreTrashedProject,
  trashStudioProject,
} from '../projectTrash'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-trash-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function makeProject(folder: string, pages: readonly string[] = ['Home.tsx']): string {
  const dir = path.join(root, folder)
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  for (const page of pages) {
    fs.writeFileSync(path.join(dir, 'pages', page), 'export default function P() { return <div /> }\n')
  }
  return dir
}

describe('trashStudioProject', () => {
  it('moves the project out of the workspace without erasing anything', () => {
    const dir = makeProject('acme')

    const destination = trashStudioProject(root, dir)

    expect(fs.existsSync(dir)).toBe(false)
    // The whole tree came along — a delete that dropped the pages would be a
    // delete, not a trash.
    expect(fs.existsSync(path.join(destination, 'pages', 'Home.tsx'))).toBe(true)
    expect(destination.startsWith(path.join(root, PROJECTS_TRASH_DIR_NAME))).toBe(true)
  })

  it('drops the project out of the launcher listing', () => {
    const dir = makeProject('acme')
    makeProject('beta')
    expect(listStudioProjects(root).map((p) => p.name)).toEqual(['acme', 'beta'])

    trashStudioProject(root, dir)

    expect(listStudioProjects(root).map((p) => p.name)).toEqual(['beta'])
  })

  it('never lists the trash itself as a project', () => {
    trashStudioProject(root, makeProject('acme'))

    // The trash is now a real directory sitting directly inside the workspace,
    // which is exactly the shape `listStudioProjects` calls a project.
    expect(fs.existsSync(path.join(root, PROJECTS_TRASH_DIR_NAME))).toBe(true)
    expect(listStudioProjects(root)).toEqual([])
  })

  it('keeps both copies when the same project name is deleted twice', () => {
    const first = trashStudioProject(root, makeProject('acme', ['First.tsx']))
    const second = trashStudioProject(root, makeProject('acme', ['Second.tsx']))

    expect(second).not.toBe(first)
    // The earlier deletion surviving is the whole point: an overwrite here
    // would destroy the thing the trash was built to keep.
    expect(fs.existsSync(path.join(first, 'pages', 'First.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(second, 'pages', 'Second.tsx'))).toBe(true)
  })

  it('refuses a path outside the workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-project-'))
    try {
      expect(() => trashStudioProject(root, outside)).toThrow(ProjectTrashError)
      expect(fs.existsSync(outside)).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a traversal that resolves out of the workspace', () => {
    const escaped = path.join(root, 'acme', '..', '..')
    expect(() => trashStudioProject(root, escaped)).toThrow(ProjectTrashError)
  })

  it('refuses a directory nested inside a project', () => {
    const dir = makeProject('acme')

    expect(() => trashStudioProject(root, path.join(dir, 'pages'))).toThrow(ProjectTrashError)
    expect(fs.existsSync(path.join(dir, 'pages'))).toBe(true)
  })

  it('refuses the workspace root itself', () => {
    makeProject('acme')

    expect(() => trashStudioProject(root, root)).toThrow(ProjectTrashError)
    expect(fs.existsSync(path.join(root, 'acme'))).toBe(true)
  })

  it('refuses to trash the trash', () => {
    trashStudioProject(root, makeProject('acme'))

    expect(() => trashStudioProject(root, path.join(root, PROJECTS_TRASH_DIR_NAME))).toThrow(
      ProjectTrashError,
    )
  })

  it('reports a missing project as not-found, not as a bad path', () => {
    // The route maps these two apart (404 vs 400), so the distinction has to
    // survive at this level.
    try {
      trashStudioProject(root, path.join(root, 'never-existed'))
      throw new Error('expected trashStudioProject to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectTrashError)
      expect((err as ProjectTrashError).reason).toBe('not-found')
    }
  })

  it('reports a non-project path as not-a-project', () => {
    try {
      trashStudioProject(root, path.join(root, 'acme', 'pages'))
      throw new Error('expected trashStudioProject to throw')
    } catch (err) {
      expect((err as ProjectTrashError).reason).toBe('not-a-project')
    }
  })
})

/**
 * The entry name is the trash's whole manifest (see the module doc), so the
 * two halves it encodes have to survive a round trip through a slug that
 * itself contains hyphens and digits — the shape a real project folder has.
 */
describe('parseTrashEntryName', () => {
  it('round-trips the slug and the deletion instant a real trash write produced', () => {
    const dir = makeProject('acme-widgets-2')
    const entry = path.basename(trashStudioProject(root, dir))

    const parsed = parseTrashEntryName(entry)

    expect(parsed?.slug).toBe('acme-widgets-2')
    expect(Math.abs(parsed!.trashedAt - Date.now())).toBeLessThan(60_000)
  })

  it('reads back a same-millisecond collision suffix without folding it into the slug', () => {
    expect(parseTrashEntryName('acme-2026-09-07T12-34-56-789Z-2')?.slug).toBe('acme')
  })

  it('refuses a directory a human dropped into the trash by hand', () => {
    // Listing one would mean offering a Restore whose destination nobody
    // recorded — the one way this feature could overwrite a live project.
    expect(parseTrashEntryName('some-folder')).toBeNull()
    expect(parseTrashEntryName('2026-09-07T12-34-56-789Z')).toBeNull()
  })
})

describe('listTrashedProjects', () => {
  it('is empty when nothing has ever been deleted', () => {
    expect(listTrashedProjects(root)).toEqual([])
  })

  it('reports the display name from the trashed project’s own meta.json, not the folder slug', () => {
    const dir = makeProject('acme-widgets')
    fs.mkdirSync(path.join(dir, '.studio'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.studio', 'meta.json'), JSON.stringify({ displayName: 'Acme Widgets' }))
    trashStudioProject(root, dir)

    const [trashed] = listTrashedProjects(root)

    expect(trashed!.name).toBe('Acme Widgets')
    expect(trashed!.slug).toBe('acme-widgets')
    expect(trashed!.sizeBytes).toBeGreaterThan(0)
    expect(trashed!.sizeCapped).toBe(false)
  })

  it('falls back to the slug for a project that never had a display name', () => {
    trashStudioProject(root, makeProject('acme'))

    expect(listTrashedProjects(root)[0]!.name).toBe('acme')
  })

  it('skips a hand-dropped folder rather than listing it with a guessed slug', () => {
    trashStudioProject(root, makeProject('acme'))
    fs.mkdirSync(path.join(root, PROJECTS_TRASH_DIR_NAME, 'dropped-by-hand'), { recursive: true })

    expect(listTrashedProjects(root).map((p) => p.slug)).toEqual(['acme'])
  })
})

describe('restoreTrashedProject', () => {
  it('moves the project back under its original slug and out of the trash', () => {
    const dir = makeProject('acme')
    const entry = path.basename(trashStudioProject(root, dir))

    const restored = restoreTrashedProject(root, entry)

    expect(restored).toBe(dir)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
    expect(listTrashedProjects(root)).toEqual([])
    expect(listStudioProjects(root).map((p) => p.name)).toEqual(['acme'])
  })

  it('refuses when a live project already occupies the slug, and keeps both copies', () => {
    const entry = path.basename(trashStudioProject(root, makeProject('acme', ['Old.tsx'])))
    makeProject('acme', ['New.tsx'])

    try {
      restoreTrashedProject(root, entry)
      throw new Error('expected restoreTrashedProject to throw')
    } catch (err) {
      expect((err as ProjectTrashError).reason).toBe('slug-taken')
    }
    // Neither side was touched: the live project keeps its file, and the
    // trashed one is still recoverable once the collision is resolved.
    expect(fs.existsSync(path.join(root, 'acme', 'pages', 'New.tsx'))).toBe(true)
    expect(fs.existsSync(path.join(root, PROJECTS_TRASH_DIR_NAME, entry, 'pages', 'Old.tsx'))).toBe(true)
  })

  it('refuses a traversal out of the trash', () => {
    const dir = makeProject('acme')

    expect(() => restoreTrashedProject(root, '../acme')).toThrow(ProjectTrashError)
    expect(() => restoreTrashedProject(root, '../../etc')).toThrow(ProjectTrashError)
    // The live project a traversal was aiming at is still there.
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('refuses an absolute path', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-in-trash-'))
    try {
      expect(() => restoreTrashedProject(root, outside)).toThrow(ProjectTrashError)
      expect(fs.existsSync(outside)).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports an entry that is already gone as not-found', () => {
    try {
      restoreTrashedProject(root, 'acme-2026-09-07T12-34-56-789Z')
      throw new Error('expected restoreTrashedProject to throw')
    } catch (err) {
      expect((err as ProjectTrashError).reason).toBe('not-found')
    }
  })
})

describe('purgeTrashedProject', () => {
  it('erases one entry and leaves the rest of the trash alone', () => {
    const first = path.basename(trashStudioProject(root, makeProject('acme')))
    const second = path.basename(trashStudioProject(root, makeProject('beta')))

    purgeTrashedProject(root, first)

    expect(listTrashedProjects(root).map((p) => p.entry)).toEqual([second])
    expect(fs.existsSync(path.join(root, PROJECTS_TRASH_DIR_NAME, first))).toBe(false)
  })

  it('refuses a traversal, so the only rmSync in the feature can never reach a live project', () => {
    const dir = makeProject('acme')

    expect(() => purgeTrashedProject(root, '../acme')).toThrow(ProjectTrashError)
    expect(() => purgeTrashedProject(root, '..')).toThrow(ProjectTrashError)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.tsx'))).toBe(true)
  })

  it('refuses a path nested inside a trash entry', () => {
    const entry = path.basename(trashStudioProject(root, makeProject('acme')))

    expect(() => purgeTrashedProject(root, `${entry}/pages`)).toThrow(ProjectTrashError)
    expect(fs.existsSync(path.join(root, PROJECTS_TRASH_DIR_NAME, entry, 'pages'))).toBe(true)
  })
})
