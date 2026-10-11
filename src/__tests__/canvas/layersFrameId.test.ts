/**
 * SB-1 — a Layers-panel row names ONE board frame, so its selection/hover ring
 * is not mirrored (and paid for) in every frame that renders the same page.
 */
import { describe, expect, it } from 'bun:test'
import { selectLayersFrameId } from '@site/store/slices/boardSelectors'
import { createBoard, createBoardsFile, type BoardFrame } from '@core/studio-board'
import type { EditorStore } from '@site/store/types'

function storeWith(frames: BoardFrame[], overrides: Partial<EditorStore>): EditorStore {
  const board = { ...createBoard('bd', 'Board'), frames }
  const boards = { ...createBoardsFile(), boards: [board] }
  return { boards, activeBoardId: board.id, activeDocument: null, activePageId: 'a', selectedNodeFrameId: null, ...overrides } as unknown as EditorStore
}

const frame = (id: string, pageId: string): BoardFrame => ({ id, pageId, x: 0, y: 0 })

describe('selectLayersFrameId', () => {
  it('names the first frame that shows the active page', () => {
    const s = storeWith([frame('f-b', 'b'), frame('f-a1', 'a'), frame('f-a2', 'a')], {})
    expect(selectLayersFrameId(s)).toBe('f-a1')
  })

  it('keeps the variant frame the user last worked in', () => {
    const s = storeWith([frame('f-a1', 'a'), frame('f-a2', 'a')], { selectedNodeFrameId: 'f-a2' })
    expect(selectLayersFrameId(s)).toBe('f-a2')
  })

  it('ignores a remembered frame of another page', () => {
    const s = storeWith([frame('f-a1', 'a'), frame('f-b', 'b')], { selectedNodeFrameId: 'f-b' })
    expect(selectLayersFrameId(s)).toBe('f-a1')
  })

  it('is null for a Visual Component document or a page no frame shows', () => {
    expect(selectLayersFrameId(storeWith([frame('f-a1', 'a')], { activeDocument: { kind: 'visualComponent', vcId: 'v' } as EditorStore['activeDocument'] }))).toBeNull()
    expect(selectLayersFrameId(storeWith([frame('f-b', 'b')], {}))).toBeNull()
  })
})
