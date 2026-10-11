/**
 * Architecture gate - the live presence channel never writes.
 *
 * The WebSocket is a roster + presence bus. Every edit still goes through the
 * HTTP routes, the route gate and the project write lock, so there is exactly
 * one write policy. The way that policy gets a second copy is a live handler
 * importing a writeback or codemod module "just to apply a change from a
 * peer". This gate stops that import, and keeps every other WebSocket
 * handler out of the Studio handlers.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSource, walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const LIVE_DIR = join(REPO_ROOT, 'server', 'handlers', 'studio', 'live')

const FORBIDDEN_IMPORT =
  /from\s+['"][^'"]*(studioWriteback|studioEditSequence|ast-codemods|css-codemods|studioSaveRequests|undoJournal|boardGeometry|commentsStore|writeFile|node:fs)[^'"]*['"]/

describe('studio live channel', () => {
  const files = walkSourceTree(LIVE_DIR, ['.ts']).filter((file) => !file.includes('__tests__'))

  it('has handler files to scan', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
  })

  it('imports no write path (writeback, codemods, journals, the filesystem)', () => {
    const offenders = files.filter((file) => FORBIDDEN_IMPORT.test(readSource(file)))
    expect(offenders).toEqual([])
  })

  it('opens no Bun.serve listener of its own (the admin listener owns the upgrade)', () => {
    const offenders = files.filter((file) => /Bun\.serve\s*\(/.test(readSource(file)))
    expect(offenders).toEqual([])
  })
})
