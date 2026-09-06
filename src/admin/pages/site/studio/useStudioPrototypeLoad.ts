/**
 * Studio prototype flows — the LOAD half.
 *
 * Exactly `useStudioCommentsLoad`'s shape, and for the same reasons: there is
 * no save half (authored links are written through one op at a time by
 * `prototypeActions`), and the `CMS_SITE_RELOAD_EVENT` re-fetch is what keeps a
 * project switch from showing the previous project's flows over this one's
 * frames.
 *
 * Mounted in the lazy editor body (`AdminCanvasEditorBody`) rather than the
 * route shell, next to `useStudioCommentsLoad`, for the bundle-budget reason
 * that hook's doc explains at length: a flow is only meaningful once there is a
 * board to draw it on, and the CMS editor will never render one.
 *
 * WHY THE CODE FLOW RE-DERIVES ON EVERY RELOAD EVENT
 * ──────────────────────────────────────────────────
 * `CMS_SITE_RELOAD_EVENT` fires after a project switch AND after a write to the
 * user's source. The second is exactly when a flow can change — an added
 * `<Link to>` is a new arrow — so a map that only loaded once would quietly
 * become a claim about a file that no longer says that. The server memoizes on
 * the pages' mtimes, so a reload that changed nothing navigational costs a
 * `statSync` per page.
 */
import { useEffect } from 'react'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { reloadCodeFlow, reloadPrototype } from './prototypeActions'

export function useStudioPrototypeLoad(): void {
  useEffect(() => {
    function load() {
      void reloadPrototype()
      void reloadCodeFlow()
    }

    load()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, load)
    return () => {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, load)
    }
  }, [])
}
