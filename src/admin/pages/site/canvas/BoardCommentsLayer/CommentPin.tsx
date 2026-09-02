/**
 * CommentPin — the marker on the board, wearing its author's face.
 *
 * WHO, NOT WHICH
 * ──────────────
 * The pin shows the thread STARTER's avatar rather than the thread's `seq`.
 * On a board mid-review the useful question at a glance is "who is asking",
 * not "which number is this" — the number only becomes useful once you are
 * already talking about a specific thread, by which point you are reading the
 * panel or the popover, where it still appears.
 *
 * `seq` has NOT stopped being the thread's name. It is stable for the life of
 * the project and never reused, so "look at 3" still means the same thing
 * tomorrow and in an agent's tool call. It stays in the pin's accessible name,
 * in the hover peek, in the panel row, and in every MCP payload. What changed
 * is only which of the two the 26px marker spends its space on.
 *
 * The avatar is the real uploaded picture (or Gravatar identicon) when the
 * author is the signed-in user, and the shared `UserAvatar` primitive's
 * initials circle otherwise — see `commentAvatarUser`, which the panel row uses
 * too so one author cannot wear two different faces in the two places that show
 * the same thread.
 *
 * A resolved pin keeps a grey ring instead of the amber one: the filter decides
 * visibility, and when someone has deliberately switched to All or Resolved
 * they need to tell the two apart at a glance.
 *
 * HOVER PEEK
 * ──────────
 * Hovering shows the thread's LATEST comment — the state of the conversation,
 * not how it started. On a board with a dozen pins, "what is the current
 * answer here" is the question you are actually asking as you sweep the
 * cursor, and the opening comment is the one thing you can usually already
 * remember. Figma's own hover card does the same.
 *
 * It is a peek, not a popover: `pointer-events: none`, no focus, no actions,
 * and it never appears for the thread that is already open (its real popover
 * is saying more, and two cards on one pin is just clutter). Rendered as a
 * sibling of the pin so it inherits the counter-scale, and clamped to three
 * lines so a long comment cannot cover the board.
 *
 * DRAGGING
 * ────────
 * A pin can be picked up and dropped somewhere else — the repair path for a
 * comment that was placed a few pixels off, and the only way to re-point one
 * whose element has since moved out from under it.
 *
 * The drop RE-RESOLVES the anchor from scratch (`commentAnchorAtPoint`, the
 * same function that places a new pin), so a pin dragged onto a different
 * element now points at that element: new frame, new frame-local offset, new
 * node hint. That is the honest reading of the gesture — you moved the marker
 * onto a thing, so the marker is about that thing — and it is what makes a
 * dragged pin a repair rather than a cosmetic nudge. A `detached` thread
 * becomes `exact` again by being dropped where it belongs.
 *
 * Three details worth keeping:
 *
 *   - **Pointer capture is required, not defensive.** The board is a field of
 *     iframes; without capture the parent document stops seeing `pointermove`
 *     the instant the cursor crosses into a frame, and the pin freezes
 *     mid-drag.
 *   - **The preview is a screen-pixel offset, not a re-computed coordinate.**
 *     `--pin-drag-x/y` are raw cursor deltas, and stay raw because the CSS
 *     applies them INSIDE the counter-scale, where the canvas zoom cancels out
 *     — see the transform's own comment, which is the one place this is easy to
 *     get backwards. Only the drop converts to board coordinates, once.
 *   - **The offset is cleared after the write settles, not on pointer-up.** The
 *     move is a server round trip; clearing early would snap the pin back to
 *     its old spot for a frame before it jumps to the new one. On failure the
 *     same clear puts it back where it started, which is exactly right — the
 *     toast says why.
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectThreadAnchorConfidence } from '@site/store/slices/commentSelectors'
import { moveThreadPin } from '@site/studio/commentActions'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { commentAvatarUser } from '@site/studio/commentAvatarUser'
import type { CommentThread } from '@core/studio-comments'
import { cn } from '@ui/cn'
import { canvasTransformLayerOf } from '../canvasZoom'
import { commentAnchorAtPoint } from './commentAnchorAtPoint'
import styles from './CommentPin.module.css'

/**
 * How far the cursor must travel before a press becomes a drag rather than a
 * click. Below this, the gesture opens the thread — a pin is a button first.
 */
const DRAG_THRESHOLD_PX = 3

/** The avatar's diameter, inset within the 26px pin so its colour still shows. */
const AVATAR_PX = 18

interface CommentPinProps {
  thread: CommentThread
  active: boolean
}

export function CommentPin({ thread, active }: CommentPinProps) {
  const setActiveCommentThread = useEditorStore((s) => s.setActiveCommentThread)
  const confidence = useEditorStore((s) => selectThreadAnchorConfidence(s, thread))
  const currentUser = useCurrentAdminUser()
  const [peeking, setPeeking] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pinRef = useRef<HTMLButtonElement>(null)
  /**
   * Set the moment a press crosses the threshold and cleared by the NEXT
   * press — not on pointer-up, because the `click` that must be swallowed
   * arrives after it.
   */
  const draggedRef = useRef(false)
  /** Tears down a live drag. Held in a ref so unmount can call it. */
  const endDragRef = useRef<(() => void) | null>(null)

  useEffect(() => () => endDragRef.current?.(), [])

  const setOffset = (x: number, y: number) => {
    const el = pinRef.current
    if (!el) return
    el.style.setProperty('--pin-drag-x', `${x}px`)
    el.style.setProperty('--pin-drag-y', `${y}px`)
  }

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Left button only, and never while the thread's own popover is being
    // interacted with — a right-click here belongs to the context menu.
    if (event.button !== 0) return
    const pin = event.currentTarget
    const layer = canvasTransformLayerOf(pin)
    if (!layer) return

    draggedRef.current = false
    const startX = event.clientX
    const startY = event.clientY
    let moved = false

    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown, true)
      endDragRef.current = null
      try {
        pin.releasePointerCapture(event.pointerId)
      } catch {
        // Already released — the pointer was cancelled or the element is gone.
      }
    }

    const abort = () => {
      finish()
      setOffset(0, 0)
      setDragging(false)
      // The press is over, so nothing is left to suppress: a cancelled drag
      // produces no click, and letting the flag stand would eat the next one.
      draggedRef.current = false
    }

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      if (!moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
        moved = true
        draggedRef.current = true
        setDragging(true)
      }
      setOffset(dx, dy)
    }

    const onUp = (upEvent: PointerEvent) => {
      finish()
      if (!moved) return
      void (async () => {
        await moveThreadPin(thread.id, commentAnchorAtPoint(layer, upEvent.clientX, upEvent.clientY))
        // Only now: on success the store already carries the new anchor, so
        // clearing the offset is a no-op on screen instead of a flash back to
        // the old position. On failure it restores the original spot.
        setOffset(0, 0)
        setDragging(false)
      })()
    }

    const onCancel = () => abort()
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      abort()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown, true)
    endDragRef.current = abort
    try {
      // Last, and non-fatal. Capture is what keeps `pointermove` coming once
      // the cursor crosses into a frame's iframe, so losing it degrades the
      // drag rather than breaking it — the window listeners above still fire
      // over the parent document. Throwing here after they were attached would
      // strand them.
      pin.setPointerCapture(event.pointerId)
    } catch {
      // InvalidPointerId — the pointer was already released.
    }
  }
  const replies = thread.comments.length - 1
  const detached = confidence === 'detached'
  const latest = thread.comments[thread.comments.length - 1]

  // The pin is a real button so it is tab-reachable and announces itself; the
  // accessible name carries what the marker can only imply — who started the
  // thread, how long it has grown, and whether its target still exists.
  const label = [
    `Comment ${thread.seq}`,
    `by ${thread.comments[0]?.author.displayName ?? 'Unknown'}`,
    replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null,
    thread.resolved ? 'resolved' : null,
    detached ? 'element missing' : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <>
    <button
      type="button"
      ref={pinRef}
      className={cn(
        styles.pin,
        active && styles.active,
        thread.resolved && styles.resolved,
        dragging && styles.dragging,
      )}
      // Defaults for the drag offset, so the transform below is valid on the
      // first paint and `var()` never falls back.
      style={{ '--pin-drag-x': '0px', '--pin-drag-y': '0px' } as CSSProperties}
      data-testid={`comment-pin-${thread.seq}`}
      data-confidence={confidence}
      data-dragging={dragging ? 'true' : undefined}
      aria-label={label}
      aria-expanded={active}
      // NO `onPointerDown` stopPropagation — see `CommentThreadPopover`. It
      // blinds `@use-gesture`, whose `filterTaps` click suppressor then eats
      // this button's own click whenever the last gesture it DID see was a
      // drag. That is why clicking a pin worked right after a click on empty
      // canvas and silently stopped working after any pan: the suppression is
      // stale-state dependent, so it looks intermittent rather than broken.
      //
      // Nothing needed it. While the comment tool is armed,
      // `CommentPlacementLayer` sits above the pin and takes the click, so
      // this can never place a second pin on top of itself; and
      // `handleCanvasClick` already ignores any target but the canvas root
      // and transform layer, so it cannot clear the selection either.
      onPointerDown={beginDrag}
      onClick={(event) => {
        event.stopPropagation()
        // The click that ends a drag is not a request to open the thread.
        if (draggedRef.current) {
          draggedRef.current = false
          return
        }
        setActiveCommentThread(active ? null : thread.id)
      }}
      // Pointer events rather than CSS `:hover` on a sibling: the peek is not
      // a descendant of the pin (it must not inherit the pin's rounded, tiny
      // box), and `:hover` on the pin cannot reach a later sibling that is
      // positioned outside it.
      onPointerEnter={() => setPeeking(true)}
      onPointerLeave={() => setPeeking(false)}
      // A pin reached by keyboard should peek too — otherwise the preview is
      // mouse-only, which makes it a decoration rather than information.
      onFocus={() => setPeeking(true)}
      onBlur={() => setPeeking(false)}
    >
      <UserAvatar
        user={commentAvatarUser(thread.comments[0]?.author, currentUser)}
        size={AVATAR_PX}
        // Decorative: everything it conveys is already in the button's own
        // `aria-label`, and announcing the author twice on focus is worse than
        // not announcing them at all.
        alt={null}
        className={styles.avatar}
      />
      {detached ? <span className={styles.detached} aria-hidden="true" /> : null}
    </button>

    {peeking && !dragging && !active && latest ? (
      // `aria-hidden`: everything here is already in the pin's own
      // `aria-label`, and announcing it twice on focus is worse than not
      // announcing it at all.
      <div className={styles.peek} data-testid={`comment-peek-${thread.seq}`} aria-hidden="true">
        <span className={styles.peekAuthor}>
          {latest.author.displayName}
          {thread.comments.length > 1 ? (
            <span className={styles.peekMeta}>
              {' · '}
              {replies} {replies === 1 ? 'reply' : 'replies'}
            </span>
          ) : null}
        </span>
        <span className={styles.peekBody}>{latest.body}</span>
      </div>
    ) : null}
    </>
  )
}
