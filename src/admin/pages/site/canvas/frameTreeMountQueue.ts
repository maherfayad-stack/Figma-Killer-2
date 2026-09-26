/**
 * frameTreeMountQueue — which canvas frame may mount its node tree next.
 *
 * `IframeFrameSurface` mounts in three commits (S1, see its header); the third
 * — the page's node tree, by far the most expensive — is a `startTransition`.
 * Before this queue every frame started that transition from its own effect,
 * and they all started within one burst of iframe `load`s. React renders every
 * pending transition lane TOGETHER (`getNextLanes` groups the transition
 * lanes), so ten on-screen frames rendered as ONE update and committed in ONE
 * commit: the first frame could not paint before the tenth had rendered. P6-B
 * measured it on the warm 40-page open — all ten trees committed within 60 ms
 * of each other, 1.3–1.9 s after their shells (`perf-16`).
 *
 * So only ONE frame at a time holds the grant. A frame asks with
 * {@link requestFrameTreeMount} once its document exists; the holder releases
 * as soon as its tree has committed (or it unmounts), and only then is the
 * next frame granted — from that frame's passive effect, i.e. after the commit,
 * so the previous frame is on screen and the browser gets its paint while the
 * next tree renders (a transition render yields every few ms). Each frame is
 * its own commit and its own paint.
 *
 * **The next frame is the one closest to the viewport centre**, measured when
 * the grant is handed out (a pan while frames are still mounting re-orders
 * what is left). One `getBoundingClientRect` per waiting frame per grant: a
 * read, with no write in the same pass — the grant's own `setState` renders
 * later, in React's own task. A frame whose element is gone sorts last.
 *
 * **No timer anywhere.** Granting happens synchronously on a request (when
 * nothing holds the grant) or on a release. `rAF` never fires in a
 * backgrounded tab or a headless runner, and the staging chain a predecessor
 * removed stranded frames as skeletons exactly that way (S1); a release is an
 * effect, which always runs. The holder cannot starve the queue: its tree is a
 * transition, which always completes, and an unmount releases too.
 *
 * Module-scoped on purpose: it is ONE queue across every canvas frame in the
 * document — the board's frames, the CMS editor's breakpoint frames — because
 * the lane they would otherwise share is one per React root, not per board.
 * A capture frame (`AgentSnapshotFrame`) never queues; see `IframeFrameSurface`.
 */

interface Waiter {
  /** The frame's own element, read at grant time for its distance to the viewport centre. */
  readonly element: () => Element | null
  readonly grant: () => void
}

/** A frame's place in the queue. `release` is idempotent. */
export interface FrameTreeMountTicket {
  /** The frame's tree committed, or the frame is going away: leave the queue, and hand the grant on if this frame held it. */
  release: () => void
}

/** Insertion-ordered, so equally-distant frames are granted first come, first served. */
const waiting = new Set<Waiter>()
let holder: Waiter | null = null

/**
 * How far `element`'s box is from the centre of its window's viewport: 0 when
 * the centre is inside the box. A frame straddling the centre beats a small
 * one beside it, which is what "the frame you are looking at" means.
 */
function distanceToViewportCentre(element: Element | null): number {
  const view = element?.ownerDocument.defaultView
  if (!element || !view) return Number.POSITIVE_INFINITY
  const rect = element.getBoundingClientRect()
  const cx = view.innerWidth / 2
  const cy = view.innerHeight / 2
  const dx = Math.max(rect.left - cx, 0, cx - rect.right)
  const dy = Math.max(rect.top - cy, 0, cy - rect.bottom)
  return Math.hypot(dx, dy)
}

function grantNext(): void {
  if (holder !== null || waiting.size === 0) return
  let best: Waiter | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const waiter of waiting) {
    const distance = distanceToViewportCentre(waiter.element())
    if (best === null || distance < bestDistance) {
      best = waiter
      bestDistance = distance
    }
  }
  if (!best) return
  waiting.delete(best)
  holder = best
  best.grant()
}

/**
 * Queue a frame's node-tree mount. `grant` is called exactly once, when it is
 * this frame's turn — immediately when no frame holds the grant. The caller
 * must `release()` once the tree has committed, and on unmount.
 */
export function requestFrameTreeMount(element: () => Element | null, grant: () => void): FrameTreeMountTicket {
  const waiter: Waiter = { element, grant }
  waiting.add(waiter)
  grantNext()
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      waiting.delete(waiter)
      if (holder === waiter) {
        holder = null
        grantNext()
      }
    },
  }
}

/** Test/diagnostic only: how many frames are waiting, and whether one holds the grant. */
export function frameTreeMountQueueState(): { waiting: number; granted: boolean } {
  return { waiting: waiting.size, granted: holder !== null }
}
