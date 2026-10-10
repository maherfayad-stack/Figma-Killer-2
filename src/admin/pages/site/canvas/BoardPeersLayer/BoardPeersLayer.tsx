/**
 * BoardPeersLayer - other people's cursors and selection rings.
 *
 * Lives inside `CanvasTransformLayer` like every board layer, so a position in
 * BOARD coordinates inherits pan and zoom for free, and nothing is added inside
 * a frame's DOM. The layer is click-through: a peer can never block your
 * pointer. Cursors and labels counter-scale by `1 / var(--canvas-zoom)` in CSS
 * so they stay one size at any zoom, the same trick comment pins use.
 *
 * Presence is ephemeral and read-only here - nothing in this layer writes.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { liveColorVar } from '@core/studio-live'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import {
  useLivePresence,
  visiblePeerSelections,
} from '../../studio/live/livePresenceStore'
import { findTransformLayer } from '../../studio/live/liveBoardPoint'
import { boardRectsEqual, measurePeerSelectionRects, type BoardRect } from './peerSelectionRects'
import styles from './BoardPeersLayer.module.css'

/** Rings re-measure on this cadence; presence frames and frame moves both change them. */
const RING_REMEASURE_MS = 150

function colorStyle(colorIndex: number): CSSProperties {
  return { '--peer-color': liveColorVar(colorIndex) } as CSSProperties
}

export function BoardPeersLayer() {
  const board = useEditorStore(selectActiveBoard)
  const members = useLivePresence((s) => s.members)
  const presence = useLivePresence((s) => s.presence)
  const rev = useLivePresence((s) => s.rev)

  if (!board) return null

  const cursors = Object.entries(presence).filter(([id, peer]) => peer.cursor && members[id])
  const selections = visiblePeerSelections(presence, rev).filter(({ memberId }) => members[memberId])

  return (
    <div className={styles.layer} data-testid="board-peers-layer">
      {selections.map(({ memberId, selection }) => (
        <PeerSelectionRings
          key={memberId}
          memberId={memberId}
          pageId={selection.pageId}
          nodeIds={selection.ids}
        />
      ))}
      {cursors.map(([id, peer]) => {
        const member = members[id]
        if (!member || !peer.cursor) return null
        return (
          <div
            key={id}
            className={styles.cursor}
            data-testid="peer-cursor"
            data-member-id={id}
            style={{
              ...colorStyle(member.colorIndex),
              '--peer-x': `${peer.cursor.x}px`,
              '--peer-y': `${peer.cursor.y}px`,
            } as CSSProperties}
          >
            <span className={styles.pointer} aria-hidden="true" />
            <span className={styles.label}>{member.name}</span>
          </div>
        )
      })}
    </div>
  )
}

function PeerSelectionRings({
  memberId,
  pageId,
  nodeIds,
}: {
  memberId: string
  pageId: string | null
  nodeIds: readonly string[]
}) {
  const member = useLivePresence((s) => s.members[memberId])
  const [rects, setRects] = useState<BoardRect[]>([])

  useEffect(() => {
    if (!pageId) return
    function measure(): void {
      const layer = findTransformLayer()
      const next = layer && pageId ? measurePeerSelectionRects(layer, pageId, nodeIds) : []
      setRects((previous) => (boardRectsEqual(previous, next) ? previous : next))
    }
    measure()
    const timer = setInterval(measure, RING_REMEASURE_MS)
    return () => clearInterval(timer)
  }, [pageId, nodeIds])

  if (!member || !pageId || rects.length === 0) return null
  return (
    <>
      {rects.map((rect, i) => (
        <div
          // The rect list is positional; ids can repeat across a re-measure.
          key={`${nodeIds[i] ?? i}`}
          className={styles.ring}
          data-testid="peer-selection-ring"
          data-member-id={memberId}
          style={{
            ...colorStyle(member.colorIndex),
            '--ring-x': `${rect.x}px`,
            '--ring-y': `${rect.y}px`,
            '--ring-w': `${rect.width}px`,
            '--ring-h': `${rect.height}px`,
          } as CSSProperties}
        >
          {i === 0 ? <span className={styles.ringLabel}>{member.name}</span> : null}
        </div>
      ))}
    </>
  )
}
