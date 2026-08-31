/**
 * Studio review comments — the LOAD half.
 *
 * There is no save half, and that asymmetry with `useStudioBoardsPersistence`
 * is the design rather than an omission. Board geometry accumulates local edits
 * and flushes them on an 800 ms debounce; a comment is written through
 * immediately, one operation at a time, by `@site/studio/commentActions` (see
 * `commentsSlice`'s doc for why a debounce would be wrong here — it would mean
 * a reply the author watched appear on screen and a browser close silently
 * discarded). So this hook only has to get the file in, and get it again
 * whenever the active project changes.
 *
 * The `CMS_SITE_RELOAD_EVENT` re-fetch matters for the same reason the boards
 * loader's does: after a project switch, writing this project's comments into
 * the previous project's file would be silent data loss.
 *
 * WHY IT LIVES IN THE LAZY EDITOR BODY, NOT THE ROUTE SHELL
 * ────────────────────────────────────────────────────────
 * It was in `AdminCanvasLayout` first, and that pushed `SitePage-*.js` past its
 * bundle budget. That budget's own note says what to do about it — "audit what
 * is actually in the shell rather than raising this again" — and the audit is
 * short: comments are only meaningful once there is a board to pin them on, and
 * the board is `CanvasRoot`, which lives in `AdminCanvasEditorBody`. Loading
 * them from the shell meant the CMS editor paid for the comments graph on a
 * route that will never render a pin. Mounting it beside
 * `useRegisterProjectModules` / `usePreviewAxesHydration` — the other
 * editor-only studio hooks — puts it in the chunk it belongs to.
 */
import { useEffect } from 'react'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { reloadComments } from './commentActions'

export function useStudioCommentsLoad(studioMode: boolean): void {
  useEffect(() => {
    if (!studioMode) return undefined

    function load() {
      void reloadComments()
    }

    load()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, load)
    return () => {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, load)
    }
  }, [studioMode])
}
