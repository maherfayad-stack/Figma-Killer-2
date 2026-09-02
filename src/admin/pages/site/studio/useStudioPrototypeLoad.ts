/**
 * Studio prototype links — the LOAD half.
 *
 * There is no save half, for the same reason `useStudioCommentsLoad` has none:
 * every write goes through immediately, one op at a time, in
 * `@site/studio/prototypeActions`. Board geometry is the only studio state that
 * needs the 800 ms debounce, because it is the only one produced by dragging.
 *
 * The `CMS_SITE_RELOAD_EVENT` re-fetch matters for the same reason the boards
 * and comments loaders' do: after a project switch, writing this project's
 * links into the previous project's file would be silent data loss.
 *
 * Mounted in the lazy editor body beside the other editor-only studio hooks,
 * not in the route shell — links are only meaningful once there is a board.
 */
import { useEffect } from 'react'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { reloadPrototype } from './prototypeActions'

export function useStudioPrototypeLoad(): void {
  useEffect(() => {
    function load() {
      void reloadPrototype()
    }

    load()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, load)
    return () => {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, load)
    }
  }, [])
}
