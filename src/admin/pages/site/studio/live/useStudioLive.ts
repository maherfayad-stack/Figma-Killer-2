/**
 * useStudioLive - joins the open project's presence room for as long as the
 * editor body is mounted, and runs the senders.
 *
 * Mounted once, in `AdminCanvasEditorBody`, beside the other editor-only
 * loaders. The connection is keyed on the project the editor actually loaded
 * (`siteId` changes when the board does), resolved with the same
 * `studioWriteDir()` every other Studio call uses, so the room is always the
 * project the canvas is showing.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { studioWriteDir } from '../studioWorkspaceDir'
import { startStudioLive } from './studioLiveConnection'
import { useLiveCursorSender } from './useLiveCursorSender'
import { useLiveFollow } from './useLiveFollow'
import { useLiveSelectionSender } from './useLiveSelectionSender'

export function useStudioLive(): void {
  const siteId = useEditorStore((s) => s.site?.id ?? null)

  useEffect(() => {
    // No loaded project yet: the first load's dir is not known, and a room for
    // "the first project on disk" would be a different room than the canvas.
    if (!siteId) return
    return startStudioLive(studioWriteDir())
  }, [siteId])

  useLiveCursorSender()
  useLiveSelectionSender()
  useLiveFollow()
}
