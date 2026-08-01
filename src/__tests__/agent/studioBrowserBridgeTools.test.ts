/**
 * `studio_set_frame_axes` / `studio_duplicate_frame_as_variant` /
 * `studio_upload_asset` (WS-12 §6.1 parity gaps, closed) — dispatched
 * through `executeAgentTool`, the SAME entry point production uses for both
 * the in-process chat loop and the MCP browser bridge. Follows
 * `executor.test.ts`'s own established pattern: the real `useEditorStore`,
 * reset per test, no mocked store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { executeAgentTool } from '@site/agent'
import { useAdminUi } from '@admin/state/adminUi'
import { createBoard, createBoardsFile, upsertBoard, upsertFrame } from '@core/studio-board'
import type { AiToolOutput } from '@core/ai'
import '@modules/base'

function expectOk<T extends Record<string, unknown>>(result: AiToolOutput): T {
  expect(result.ok).toBe(true)
  expect(result.error).toBeUndefined()
  return result.data as T
}

function expectError(result: AiToolOutput): string {
  expect(result.ok).toBe(false)
  expect(result.error).toBeTruthy()
  return result.error!
}

/** One board, one frame addressing pageId "home" — the minimum a `pageId`-addressed tool needs. */
function seedBoardWithFrame() {
  const board = upsertFrame(createBoard('board-1', 'Board 1'), { id: 'frame-1', pageId: 'home', x: 0, y: 0 })
  const boards = upsertBoard(createBoardsFile(), board)
  useEditorStore.setState({ boards, activeBoardId: 'board-1', boardsDirty: false })
}

describe('studio_set_frame_axes', () => {
  beforeEach(() => {
    useEditorStore.setState({ boards: createBoardsFile(), activeBoardId: null, boardsDirty: false })
  })

  it('applies the axes override to the frame addressed by pageId', async () => {
    seedBoardWithFrame()
    const result = await executeAgentTool('studio_set_frame_axes', { pageId: 'home', axes: { direction: 'rtl' } })
    const data = expectOk<{ frameId: string }>(result)
    expect(data.frameId).toBe('frame-1')
    const frame = useEditorStore.getState().boards.boards[0]!.frames[0]!
    expect(frame.axes?.direction).toBe('rtl')
  })

  it('returns an actionable error when the page has no frame on the active board', async () => {
    seedBoardWithFrame()
    const result = await executeAgentTool('studio_set_frame_axes', { pageId: 'does-not-exist', axes: { direction: 'rtl' } })
    expect(expectError(result)).toContain('No frame for page')
  })

  it('returns an error when no board is active at all', async () => {
    const result = await executeAgentTool('studio_set_frame_axes', { pageId: 'home', axes: { direction: 'rtl' } })
    expect(expectError(result)).toContain('No frame for page')
  })
})

describe('studio_duplicate_frame_as_variant', () => {
  beforeEach(() => {
    useEditorStore.setState({ boards: createBoardsFile(), activeBoardId: null, boardsDirty: false })
  })

  it('creates a new frame with the axes override, distinct from the source', async () => {
    seedBoardWithFrame()
    const result = await executeAgentTool('studio_duplicate_frame_as_variant', { pageId: 'home', axes: { colorScheme: 'dark' } })
    const data = expectOk<{ frameId: string }>(result)
    expect(data.frameId).not.toBe('frame-1')

    const frames = useEditorStore.getState().boards.boards[0]!.frames
    expect(frames).toHaveLength(2)
    const variant = frames.find((f) => f.id === data.frameId)!
    expect(variant.pageId).toBe('home')
    expect(variant.axes?.colorScheme).toBe('dark')
  })

  it('a second call can target the new variant explicitly via frameId', async () => {
    seedBoardWithFrame()
    const first = expectOk<{ frameId: string }>(
      await executeAgentTool('studio_duplicate_frame_as_variant', { pageId: 'home', axes: { colorScheme: 'dark' } }),
    )
    const second = await executeAgentTool('studio_set_frame_axes', {
      pageId: 'home',
      frameId: first.frameId,
      axes: { direction: 'rtl' },
    })
    const data = expectOk<{ frameId: string }>(second)
    expect(data.frameId).toBe(first.frameId)
  })

  it('returns an error when the page has no frame on the active board', async () => {
    seedBoardWithFrame()
    const result = await executeAgentTool('studio_duplicate_frame_as_variant', { pageId: 'does-not-exist', axes: {} })
    expect(expectError(result)).toContain('No frame for page')
  })
})

describe('studio_upload_asset', () => {
  afterEach(() => {
    useAdminUi.setState({ studioProject: null })
  })

  it('refuses when no Studio project is open — never guesses a target dir', async () => {
    useAdminUi.setState({ studioProject: null })
    const result = await executeAgentTool('studio_upload_asset', {
      imageBase64: 'AAAA',
      mimeType: 'image/png',
    })
    expect(expectError(result)).toContain('No Studio project is open')
  })

  it('refuses malformed base64 before ever attempting a network call', async () => {
    useAdminUi.setState({ studioProject: { dir: '/tmp/fake-project', name: 'fixture' } })
    const result = await executeAgentTool('studio_upload_asset', {
      // Not valid base64 (odd-length run of characters atob rejects).
      imageBase64: '!!!not-base64!!!',
      mimeType: 'image/png',
    })
    expect(expectError(result)).toContain('not valid base64')
  })
})
