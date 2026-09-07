/**
 * `studio_set_frame_axes` / `studio_duplicate_frame_as_variant` against a REAL
 * `.studio/boards.json` on disk — which is the whole point of W9-6.
 *
 * The predecessor suite drove these through the editor store and asserted on
 * the store's copy of the boards. That could not have caught the thing that
 * actually matters now: whether the FILE changed, and changed into something
 * `parseBoardsFile` will read back. So every assertion here re-reads the file
 * through the same parser the canvas loads it with.
 *
 * No browser anywhere. That is the regression these tests exist to pin: both
 * tools used to relay to an open editor tab and refuse when none was open, for
 * a write that never needed one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBoardsFile, FRAME_WIDTH, VARIANT_GAP, type BoardsFile } from '@core/studio-board'
import { studioFrameAxesMcpTools } from './frameAxesTools'

const setAxesTool = studioFrameAxesMcpTools.find((t) => t.name === 'studio_set_frame_axes')!
const duplicateTool = studioFrameAxesMcpTools.find((t) => t.name === 'studio_duplicate_frame_as_variant')!

let dir: string

function ctx() {
  return {
    userId: `u_frame_axes_${Math.floor(performance.now())}`,
    capabilities: [],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
    db: undefined,
  } as never
}

function seedBoards(json: unknown): void {
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(join(dir, '.studio', 'boards.json'), JSON.stringify(json))
}

function readBoards(): BoardsFile {
  return parseBoardsFile(readFileSync(join(dir, '.studio', 'boards.json'), 'utf8'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-frame-axes-'))
  seedBoards({
    version: 1,
    boards: [
      {
        id: 'b1',
        name: 'Board 1',
        frames: [
          { id: 'f-home', pageId: 'home', x: 0, y: 0, width: 400, height: 800 },
          { id: 'f-about', pageId: 'about', x: 480, y: 0 },
        ],
        notes: [],
        docs: [],
      },
    ],
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('studio_set_frame_axes', () => {
  it('writes the axes override into boards.json with no editor tab involved', async () => {
    const out = (await setAxesTool.handler!({ dir, pageId: 'home', axes: { direction: 'rtl' } }, ctx())) as {
      ok: boolean
      data: { frameId: string; pageId: string }
    }
    expect(out.ok).toBe(true)
    expect(out.data.frameId).toBe('f-home')
    expect(out.data.pageId).toBe('home')

    const frame = readBoards().boards[0]!.frames.find((f) => f.id === 'f-home')!
    expect(frame.axes).toEqual({ direction: 'rtl' })
  })

  it('leaves every other frame untouched', async () => {
    await setAxesTool.handler!({ dir, pageId: 'home', axes: { colorScheme: 'dark' } }, ctx())
    const about = readBoards().boards[0]!.frames.find((f) => f.id === 'f-about')!
    expect(about.axes).toBeUndefined()
    expect(about.x).toBe(480)
  })

  it('addresses a SPECIFIC frame when frameId is given, ignoring pageId', async () => {
    const out = (await setAxesTool.handler!(
      { dir, pageId: 'home', frameId: 'f-about', axes: { direction: 'rtl' } },
      ctx(),
    )) as { ok: boolean; data: { frameId: string; pageId: string } }
    expect(out.data.frameId).toBe('f-about')
    // Reported against the frame that was actually written, not the pageId the
    // caller happened to pass alongside it.
    expect(out.data.pageId).toBe('about')
    expect(readBoards().boards[0]!.frames.find((f) => f.id === 'f-home')!.axes).toBeUndefined()
  })

  it('names the page in its refusal when nothing matches, and writes nothing', async () => {
    const before = readFileSync(join(dir, '.studio', 'boards.json'), 'utf8')
    const out = (await setAxesTool.handler!({ dir, pageId: 'nope', axes: { direction: 'rtl' } }, ctx())) as {
      ok: boolean
      error: string
    }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('nope')
    expect(readFileSync(join(dir, '.studio', 'boards.json'), 'utf8')).toBe(before)
  })
})

describe('studio_duplicate_frame_as_variant', () => {
  it('appends a variant beside the source, carrying its page and size, with its own id and axes', async () => {
    const out = (await duplicateTool.handler!(
      { dir, pageId: 'home', axes: { direction: 'rtl' } },
      ctx(),
    )) as { ok: boolean; data: { frameId: string; sourceFrameId: string; x: number; y: number } }
    expect(out.ok).toBe(true)
    expect(out.data.sourceFrameId).toBe('f-home')
    expect(out.data.frameId).not.toBe('f-home')

    const frames = readBoards().boards[0]!.frames
    expect(frames).toHaveLength(3)
    const created = frames.find((f) => f.id === out.data.frameId)!
    expect(created.pageId).toBe('home')
    expect(created.width).toBe(400)
    expect(created.axes).toEqual({ direction: 'rtl' })
    // Beside the source, same row — the placement `boardSlice.ts` uses, sharing
    // the one `VARIANT_GAP`.
    expect(created.x).toBe(0 + 400 + VARIANT_GAP)
    expect(created.y).toBe(0)
    expect(out.data.x).toBe(created.x)
  })

  it('falls back to FRAME_WIDTH for a frame with no authored width, exactly as the toolbar does', async () => {
    const out = (await duplicateTool.handler!({ dir, pageId: 'about', axes: {} }, ctx())) as {
      ok: boolean
      data: { frameId: string }
    }
    expect(out.ok).toBe(true)
    const created = readBoards().boards[0]!.frames.find((f) => f.id === out.data.frameId)!
    expect(created.x).toBe(480 + FRAME_WIDTH + VARIANT_GAP)
  })

  it('returns a frameId that studio_set_frame_axes can then address directly', async () => {
    const dup = (await duplicateTool.handler!({ dir, pageId: 'home', axes: { direction: 'rtl' } }, ctx())) as {
      data: { frameId: string }
    }
    const set = (await setAxesTool.handler!(
      { dir, pageId: 'home', frameId: dup.data.frameId, axes: { colorScheme: 'dark' } },
      ctx(),
    )) as { ok: boolean }
    expect(set.ok).toBe(true)

    const frames = readBoards().boards[0]!.frames
    // The variant took the new axes; the ORIGINAL frame is still unset, which
    // is the entire reason "duplicate as variant" exists rather than a flip.
    expect(frames.find((f) => f.id === dup.data.frameId)!.axes).toEqual({ colorScheme: 'dark' })
    expect(frames.find((f) => f.id === 'f-home')!.axes).toBeUndefined()
  })

  it('refuses a page with no frame instead of inventing one', async () => {
    const out = (await duplicateTool.handler!({ dir, pageId: 'nope', axes: {} }, ctx())) as {
      ok: boolean
      error: string
    }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('nope')
    expect(readBoards().boards[0]!.frames).toHaveLength(2)
  })
})

describe('board resolution across several boards', () => {
  it('finds the frame on whichever board carries it — the server has no "active board"', async () => {
    seedBoards({
      version: 1,
      boards: [
        { id: 'b1', name: 'Board 1', frames: [], notes: [], docs: [] },
        {
          id: 'b2',
          name: 'Board 2',
          frames: [{ id: 'f-deep', pageId: 'checkout', x: 10, y: 20, width: 300 }],
          notes: [],
          docs: [],
        },
      ],
    })
    const out = (await setAxesTool.handler!({ dir, pageId: 'checkout', axes: { direction: 'rtl' } }, ctx())) as {
      ok: boolean
      data: { frameId: string }
    }
    expect(out.ok).toBe(true)
    expect(out.data.frameId).toBe('f-deep')
    const boards = readBoards().boards
    expect(boards[0]!.frames).toHaveLength(0)
    expect(boards[1]!.frames[0]!.axes).toEqual({ direction: 'rtl' })
  })
})
