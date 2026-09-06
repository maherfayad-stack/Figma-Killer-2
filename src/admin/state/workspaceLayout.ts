import { create } from 'zustand'

/**
 * Sidebar width bounds.
 *
 * The floor is 260, not 300, because the properties panel no longer spends a
 * 100px column on labels: an enum draws itself as an icon group and a length
 * carries its name as a glyph inside the field, so the panel's content is now
 * two ~120px fields and a gutter. Figma's inspector is 240px; 260 is that plus
 * our scrollbar gutter and category rail.
 */
export const SIDEBAR_MIN_WIDTH = 260
export const SIDEBAR_MAX_WIDTH = 520
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 320

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)))
}

/**
 * Left-sidebar width for the ONE non-site sidebar still in the tree: the
 * `MediaSidebar` rendered inside `MediaPickerModal`.
 *
 * This used to be a per-workspace layout store, hydrated from (and written
 * back to) `workspaceLayoutStorage` by `useWorkspaceLayoutPersistence`. The
 * Content / Data / Media workspace routes were deleted, that hook lost its
 * last call site, and everything the hook drove — the right-panel state, the
 * data-workspace sidebar flag, `hydrateWorkspaceLayout` — went with it. What
 * is left is what MediaSidebar actually reads: one width, in memory, for as
 * long as the picker is open. The Site editor's own layout is unrelated and
 * lives in the editor store (`uiSlice` + `siteEditorLayoutPersistence`).
 */
interface WorkspaceLayoutState {
  leftSidebarWidth: number
  setLeftSidebarWidth: (width: number) => void
}

export const useWorkspaceLayout = create<WorkspaceLayoutState>((set, get) => ({
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,

  setLeftSidebarWidth: (width) => {
    const nextWidth = clampSidebarWidth(width)
    if (Object.is(get().leftSidebarWidth, nextWidth)) return
    set({ leftSidebarWidth: nextWidth })
  },
}))
