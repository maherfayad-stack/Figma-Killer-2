/**
 * The Studio-project agent's live-state snapshot (WS-12 §2.1) — the browser
 * posts this every turn when a Studio project is open, exactly the way
 * `siteAgentSnapshot.ts` does for the CMS site editor.
 *
 * **This is deliberately LEANER than WS-12 §2.1's own sketch.** The sketch
 * bundles `project`/`profile`/`fidelity`/`install` into one client-built
 * object — but Studio's truth is the filesystem, not a live browser copy
 * (the same principle `editTools.ts`'s own doc comment states: "there is no
 * separate in-memory DB copy... to desync from"). Those four facts are all
 * disk-derived and the SERVER already re-derives them fresh every turn
 * (`server/ai/tools/studio/systemPrompt.ts`'s `buildStudioProjectSystemPrompt`)
 * — trusting a client-cached copy of them would be a second source of truth
 * for exactly the kind of fact this codebase goes out of its way to avoid
 * duplicating. What the client contributes here is only what the SERVER
 * cannot know without asking the browser: which board/page is on screen,
 * what's selected, and which preview axes are active. Everything else (page
 * titles, root node ids, the selected node's tag/moduleId/writableProps,
 * a fidelity digest, install status) is resolved server-side FROM these ids,
 * reading only the board's own frame list and the ONE active page's already-
 * parsed nodes — never every node of every page (trap #11).
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { PreviewAxesSchema } from '@core/studio-board'
import type { EditorStore } from '@site/store/types'
import { useAdminUi } from '@admin/state/adminUi'

const StudioBoardFrameLiveSchema = Type.Object({
  pageId: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
})

/** A node's rendered box inside its frame, in CSS px — the same space `studio_screenshot`'s `nodeRects` use. */
const FrameLocalBoxSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})

/**
 * One selected node (AI-9). `box` is what only the browser knows: where the
 * node is actually drawn. Absent when no canvas frame the admin document can
 * read renders it (a live frame is cross-origin), in which case the digest
 * says the box is unmeasured rather than inventing one.
 */
const SelectedNodeLiveSchema = Type.Object({
  nodeId: Type.String(),
  box: Type.Optional(FrameLocalBoxSchema),
})

/** How many selected nodes one snapshot carries. The digest itself details fewer; this bounds the wire. */
export const MAX_SNAPSHOT_SELECTION = 50

export const StudioAgentSnapshotSchema = Type.Object({
  activeBoardId: Type.Union([Type.String(), Type.Null()]),
  /** Every frame on the ACTIVE board only — never every board, never node data. Bounded by frame count, not node count. */
  frames: Type.Array(StudioBoardFrameLiveSchema),
  activePageId: Type.Union([Type.String(), Type.Null()]),
  /** Every selected node, in selection order — the store's `selectedNodeIds`, so the LAST entry is the primary selection (`selectedNodeId`). Empty when nothing is selected. */
  selection: Type.Array(SelectedNodeLiveSchema, { maxItems: MAX_SNAPSHOT_SELECTION }),
  axes: PreviewAxesSchema,
})

export type StudioAgentSnapshot = Static<typeof StudioAgentSnapshotSchema>

/**
 * A selection's identity — what the panel's selection chip records when the
 * user removes the selection from the next message (AI-28). Selecting
 * anything else brings the chip, and the selection, back.
 */
export function agentSelectionKey(nodeIds: readonly string[]): string {
  return nodeIds.join('|')
}

/** Measures where each node id is drawn, frame-local. Injected so this module stays importable by the server, which never touches the canvas. */
export type SelectionBoxMeasurer = (nodeIds: readonly string[]) => ReadonlyMap<string, Static<typeof FrameLocalBoxSchema>>

/**
 * Reads the store fields this snapshot needs (`boards`, `activeBoardId`,
 * `activePageId`, `selectedNodeIds`, `previewAxes`) plus `useAdminUi`'s
 * `studioProject`. Returns `undefined` when no Studio project is open —
 * `agentSliceConfig.site.ts` then falls back to the CMS snapshot builder.
 *
 * Reads the real `EditorStore` type directly (no casts) so a shape change
 * from the board/canvas/store workstream fails loudly at `tsc`, not silently
 * at runtime — the safer failure mode for a security-relevant snapshot.
 */
export function buildStudioAgentSnapshot(
  get: () => EditorStore,
  measureBoxes: SelectionBoxMeasurer = () => new Map(),
): StudioAgentSnapshot | undefined {
  if (!useAdminUi.getState().studioProject) return undefined
  const state = get()

  const activeBoard = state.boards.boards.find((b) => b.id === state.activeBoardId) ?? null
  const frames = (activeBoard?.frames ?? []).map((f) => ({
    pageId: f.pageId,
    x: f.x,
    y: f.y,
    ...(f.width !== undefined ? { width: f.width } : {}),
    ...(f.height !== undefined ? { height: f.height } : {}),
  }))

  const selectedIds = (state.selectedNodeIds.length > 0
    ? state.selectedNodeIds
    : state.selectedNodeId ? [state.selectedNodeId] : []
  ).slice(-MAX_SNAPSHOT_SELECTION)
  // The user removed this exact selection from the conversation (the chip's
  // ×): the turn is told nothing is selected, rather than something they
  // chose not to send.
  if (selectedIds.length > 0 && state.agentSelectionDismissed === agentSelectionKey(selectedIds)) selectedIds.length = 0
  const boxes = selectedIds.length > 0 ? measureBoxes(selectedIds) : new Map()
  const selection = selectedIds.map((nodeId) => {
    const box = boxes.get(nodeId)
    return box ? { nodeId, box } : { nodeId }
  })

  return {
    activeBoardId: state.activeBoardId,
    frames,
    activePageId: state.activePageId,
    selection,
    axes: state.previewAxes,
  }
}
