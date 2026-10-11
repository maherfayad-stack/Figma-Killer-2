/**
 * useLiveSelectionSender - publishes this tab's node selection.
 *
 * The selection carries the revision it was made at. When the revision moves
 * (someone, possibly us, wrote), the ids may have drifted, so after a short
 * settle the selection is announced again under the new revision; peers hide
 * selections stamped with an older one (`visiblePeerSelections`).
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { useLivePresence } from './livePresenceStore'
import { getLiveClient } from './studioLiveConnection'

const REV_SETTLE_MS = 400

export function useLiveSelectionSender(): void {
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds)
  const activePageId = useEditorStore((s) => s.activePageId)
  const rev = useLivePresence((s) => s.rev)
  const status = useLivePresence((s) => s.status)

  useEffect(() => {
    if (status !== 'live') return
    const announce = (): void => {
      getLiveClient()?.sendPresence({
        selection: selectedNodeIds.length === 0
          ? null
          : { ids: selectedNodeIds.slice(0, 64), pageId: activePageId, rev },
      })
    }
    // The first announcement after a revision change waits for the resync.
    const timer = setTimeout(announce, REV_SETTLE_MS)
    announce()
    return () => clearTimeout(timer)
  }, [selectedNodeIds, activePageId, rev, status])
}
