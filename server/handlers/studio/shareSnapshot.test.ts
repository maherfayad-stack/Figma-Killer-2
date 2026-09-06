/**
 * shareSnapshot — what gets written when a board is photographed.
 *
 * The capture itself is injected, because the assertion that matters has
 * nothing to do with pixels: it is that the manifest handed to an anonymous
 * viewer carries a name, a rectangle and a filename, and NOT a page id, a
 * source path, a node id, or the workspace directory. That is the whole
 * privacy contract of the feature, and it is a property of this writer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Board } from '@core/studio-board'
import { SharedBoardSchema } from '@core/studio-share'
import { safeParseJson } from '@core/utils/jsonValidate'
import { projectsRootDir } from '../studioProjects'
import type { captureFrames as CaptureFrames } from '../../ai/mcp/capture/captureFrames'
import { writeShareSnapshot } from './shareSnapshot'
import { clearShareLookupMemo, mintShareToken, shareSnapshotDir } from './shareStore'

let dir: string
let token: string

/** A one-pixel PNG, base64 — enough to be written and read back. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * The page ids Studio's parser produces are `relFile:line:col` — a real
 * source path. A snapshot that leaked one would tell a stranger the layout of
 * somebody's repository, so the fixture uses ids of exactly that shape.
 */
const board: Board = {
  id: 'boardIdMustNotLeak',
  name: 'Board 1',
  frames: [
    { id: 'frameIdMustNotLeak', pageId: 'src/screens/Checkout.tsx:12:4', x: 40, y: 80, width: 390, height: 844 },
    { id: 'secondFrameIdMustNotLeak', pageId: 'src/screens/Home.tsx:3:2', x: 500, y: 80 },
  ],
  notes: [],
  docs: [],
}

const titles = new Map([
  ['src/screens/Checkout.tsx:12:4', 'Checkout'],
  ['src/screens/Home.tsx:3:2', 'Home'],
])

function fakeCapture(okPageIds: readonly string[]): typeof CaptureFrames {
  return async (request) => ({
    source: 'headless',
    output: {
      ok: true,
      data: {
        frames: request.pageIds.map((pageId, index) => (
          okPageIds.includes(pageId)
            ? { pageId, ok: true, imageIndex: index }
            : { pageId, ok: false, error: 'nope' }
        )),
      },
      images: request.pageIds.map(() => ({ mimeType: 'image/png', data: PNG_BASE64 })),
    },
  })
}

beforeEach(() => {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, '__share_snapshot_test_'))
  token = mintShareToken()
  clearShareLookupMemo()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearShareLookupMemo()
})

function readManifest(): unknown {
  const file = path.join(shareSnapshotDir(dir, token)!, 'board.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

describe('writeShareSnapshot', () => {
  it('writes a manifest and one PNG per photographed frame', async () => {
    const result = await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture(board.frames.map((f) => f.pageId)), titles },
    )

    expect(result.ok).toBe(true)
    const snapshotDir = shareSnapshotDir(dir, token)!
    const files = fs.readdirSync(snapshotDir).sort()
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(2)
    expect(files).toContain('board.json')

    const parsed = safeParseJson(fs.readFileSync(path.join(snapshotDir, 'board.json'), 'utf8'), SharedBoardSchema)
    expect(parsed.ok).toBe(true)
  })

  it('carries names and board geometry, defaulting an unsized frame', async () => {
    await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture(board.frames.map((f) => f.pageId)), titles },
    )
    const manifest = readManifest() as { frames: Array<Record<string, unknown>> }

    expect(manifest.frames[0]).toMatchObject({ name: 'Checkout', x: 40, y: 80, width: 390, height: 844 })
    expect(manifest.frames[1]).toMatchObject({ name: 'Home', x: 500, y: 80 })
    // The unsized frame picked up the shared frame defaults, not `undefined`.
    expect(typeof manifest.frames[1]?.width).toBe('number')
    expect(typeof manifest.frames[1]?.height).toBe('number')
  })

  it('leaks no page id, source path, node id or workspace directory', async () => {
    await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture(board.frames.map((f) => f.pageId)), titles },
    )
    const raw = fs.readFileSync(path.join(shareSnapshotDir(dir, token)!, 'board.json'), 'utf8')

    for (const secret of [
      'src/screens',
      '.tsx',
      'Checkout.tsx',
      ':12:4',
      dir,
      'pageId',
      'boardIdMustNotLeak',
      'frameIdMustNotLeak',
      'secondFrameIdMustNotLeak',
    ]) {
      expect(raw).not.toContain(secret)
    }
    // The image filenames are opaque too — an id plus an index, nothing else.
    const manifest = readManifest() as { frames: Array<{ image: string }> }
    for (const frame of manifest.frames) {
      expect(frame.image).toMatch(/^[a-z0-9]{1,32}-\d{1,4}\.png$/)
    }
  })

  it('drops a frame the capture could not photograph, keeping the rest', async () => {
    const result = await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture(['src/screens/Home.tsx:3:2']), titles },
    )
    expect(result.ok).toBe(true)
    const manifest = readManifest() as { frames: Array<{ name: string }> }
    expect(manifest.frames.map((f) => f.name)).toEqual(['Home'])
  })

  it('refuses a board with no frames rather than publishing an empty link', async () => {
    const result = await writeShareSnapshot(
      { dir, token, board: { ...board, frames: [] }, userId: 'user-1' },
      { captureFrames: fakeCapture([]), titles },
    )
    expect(result.ok).toBe(false)
    expect(fs.existsSync(shareSnapshotDir(dir, token)!)).toBe(false)
  })

  it('refuses when nothing could be photographed at all', async () => {
    const result = await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture([]), titles },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('nothing to share')
  })

  it('surfaces a capture failure instead of writing a half-share', async () => {
    const result = await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      {
        captureFrames: async () => ({ source: 'none', output: { ok: false, error: 'no browser and no tab' } }),
        titles,
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('no browser and no tab')
    expect(fs.existsSync(shareSnapshotDir(dir, token)!)).toBe(false)
  })

  it('replaces the previous capture on an update rather than accumulating', async () => {
    await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture(board.frames.map((f) => f.pageId)), titles },
    )
    const first = fs.readdirSync(shareSnapshotDir(dir, token)!).filter((f) => f.endsWith('.png'))

    await writeShareSnapshot(
      { dir, token, board, userId: 'user-1' },
      { captureFrames: fakeCapture(board.frames.map((f) => f.pageId)), titles },
    )
    const second = fs.readdirSync(shareSnapshotDir(dir, token)!).filter((f) => f.endsWith('.png'))

    expect(second).toHaveLength(2)
    // New snapshot id ⇒ new filenames ⇒ the immutable cache header stays honest.
    expect(second.some((file) => first.includes(file))).toBe(false)
  })
})
