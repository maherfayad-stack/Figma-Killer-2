/**
 * Architecture Gate — Admin startup import shape
 *
 * The unauthenticated and bootstrapping admin shell is on every /admin first
 * paint. It may use narrow auth/boot persistence entrypoints, but it must not
 * import the full `@core/persistence` barrel because that barrel re-exports
 * data/media/plugin clients and pulls their chunks into startup.
 */

import { describe, expect, it } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'

import { join, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const STARTUP_DIRS = [
  join(REPO_ROOT, 'src/admin/preauth'),
]

const listSourceFiles = (dir: string): string[] => walkSourceTree(dir, ['.ts', '.tsx'])

describe('admin startup imports', () => {
  it('pre-auth code does not import the full persistence barrel', () => {
    const offenders = STARTUP_DIRS
      .flatMap(listSourceFiles)
      .filter((file) => readSource(file).includes("from '@core/persistence'"))
      .map((file) => relative(REPO_ROOT, file))

    expect(offenders).toEqual([])
  })
})
