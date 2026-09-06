import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  restorePersistedSiteEditorLayout,
  sameLayoutSelection,
  selectSiteLayoutState,
  writeSiteEditorLayout,
} from '@site/layout/siteEditorLayoutPersistence'

/**
 * Subscribe the Site editor store to Site-workspace layout persistence.
 *
 * This is the only layout-persistence hook left: the Content / Data / Media
 * workspaces it used to have a sibling for were deleted, and with them
 * `useWorkspaceLayoutPersistence`. What remains of the old shared store is
 * `@admin/state/workspaceLayout`, now just the in-memory left-sidebar width
 * that `MediaSidebar` reads inside the media picker.
 */
export function useEditorLayoutPersistence(): void {
  useEffect(() => {
    restorePersistedSiteEditorLayout(useEditorStore)

    let prev = selectSiteLayoutState(useEditorStore.getState())
    const unsubscribe = useEditorStore.subscribe(
      selectSiteLayoutState,
      (selection) => {
        if (sameLayoutSelection(selection, prev)) return
        prev = selection
        writeSiteEditorLayout(selection)
      },
      { equalityFn: sameLayoutSelection, fireImmediately: true },
    )
    return unsubscribe
  }, [])
}
