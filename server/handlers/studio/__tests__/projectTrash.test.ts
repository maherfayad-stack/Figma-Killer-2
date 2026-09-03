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
import { PROJECTS_TRASH_DIR_NAME, ProjectTrashError, trashStudioProject } from '../projectTrash'

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
