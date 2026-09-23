/**
 * AI-9 — the Studio agent snapshot carries the whole selection, in order,
 * with the box each node is drawn at, and validates against the schema the
 * server parses it with.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { useAdminUi } from '@admin/state/adminUi'
import type { EditorStore } from '@site/store/types'
import {
  buildStudioAgentSnapshot,
  MAX_SNAPSHOT_SELECTION,
  StudioAgentSnapshotSchema,
} from '@site/agent/studioAgentSnapshot'

function store(selectedNodeIds: string[], selectedNodeId: string | null = selectedNodeIds.at(-1) ?? null): () => EditorStore {
  const state = {
    boards: { version: 1, boards: [{ id: 'b1', name: 'Board 1', frames: [{ id: 'f1', pageId: 'checkout', x: 0, y: 0, width: 393 }], notes: [], docs: [] }] },
    activeBoardId: 'b1',
    activePageId: 'checkout',
    selectedNodeIds,
    selectedNodeId,
    previewAxes: { direction: 'ltr', colorScheme: 'light' },
  }
  return () => state as unknown as EditorStore
}

afterEach(() => {
  useAdminUi.setState({ studioProject: null })
})

describe('buildStudioAgentSnapshot — selection (AI-9)', () => {
  it('sends every selected node in selection order, each with its measured box when there is one', () => {
    useAdminUi.setState({ studioProject: { dir: '/w/p', name: 'p' } })
    const snapshot = buildStudioAgentSnapshot(store(['pages/Checkout.tsx:6:8', 'pages/Checkout.tsx:7:8']), (ids) =>
      new Map(ids.filter((id) => id.endsWith(':7:8')).map((id) => [id, { x: 24, y: 640, width: 345, height: 48 }])))
    expect(snapshot?.selection).toEqual([
      { nodeId: 'pages/Checkout.tsx:6:8' },
      { nodeId: 'pages/Checkout.tsx:7:8', box: { x: 24, y: 640, width: 345, height: 48 } },
    ])
    expect(safeParseValue(StudioAgentSnapshotSchema, snapshot).ok).toBe(true)
  })

  it('falls back to the primary id when the multi-select list is empty, and sends [] for no selection', () => {
    useAdminUi.setState({ studioProject: { dir: '/w/p', name: 'p' } })
    expect(buildStudioAgentSnapshot(store([], 'pages/A.tsx:1:1'))?.selection).toEqual([{ nodeId: 'pages/A.tsx:1:1' }])
    expect(buildStudioAgentSnapshot(store([], null))?.selection).toEqual([])
  })

  it('bounds the wire to the most recent selections, keeping the primary', () => {
    useAdminUi.setState({ studioProject: { dir: '/w/p', name: 'p' } })
    const ids = Array.from({ length: MAX_SNAPSHOT_SELECTION + 7 }, (_, i) => `pages/A.tsx:${i + 1}:1`)
    const selection = buildStudioAgentSnapshot(store(ids))!.selection
    expect(selection).toHaveLength(MAX_SNAPSHOT_SELECTION)
    expect(selection.at(-1)!.nodeId).toBe(ids.at(-1)!)
  })
})
