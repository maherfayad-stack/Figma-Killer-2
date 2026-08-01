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

export const StudioAgentSnapshotSchema = Type.Object({
  activeBoardId: Type.Union([Type.String(), Type.Null()]),
  /** Every frame on the ACTIVE board only — never every board, never node data. Bounded by frame count, not node count. */
  frames: Type.Array(StudioBoardFrameLiveSchema),
  activePageId: Type.Union([Type.String(), Type.Null()]),
  selectedNodeId: Type.Union([Type.String(), Type.Null()]),
  axes: PreviewAxesSchema,
})

export type StudioAgentSnapshot = Static<typeof StudioAgentSnapshotSchema>

/**
 * Reads the store fields this snapshot needs (`boards`, `activeBoardId`,
 * `activePageId`, `selectedNodeId`, `previewAxes`) plus `useAdminUi`'s
 * `studioProject`. Returns `undefined` when no Studio project is open —
 * `agentSliceConfig.site.ts` then falls back to the CMS snapshot builder.
 *
 * Reads the real `EditorStore` type directly (no casts) so a shape change
 * from the board/canvas/store workstream fails loudly at `tsc`, not silently
 * at runtime — the safer failure mode for a security-relevant snapshot.
 */
export function buildStudioAgentSnapshot(get: () => EditorStore): StudioAgentSnapshot | undefined {
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

  return {
    activeBoardId: state.activeBoardId,
    frames,
    activePageId: state.activePageId,
    selectedNodeId: state.selectedNodeId,
    axes: state.previewAxes,
  }
}
