/**
 * geometryDirtySignal — tells the parent when the geometry it last read from a
 * frame (`measureAll`) may be stale. One implementation for both frame kinds:
 * `runtime.ts` posts `geometry:dirty` from it, `PortalFrameAdapter` emits the
 * same event from it.
 *
 * ## Reuse first
 *
 * Both frames already run a subtree `childList` + `attributes` MutationObserver
 * on the body for ring repositioning (`runtime.ts`' `layoutObserver`,
 * `PortalFrameAdapter`' `armRingTracking`). That observer is the signal for
 * every content or style-attribute change, so it calls {@link
 * GeometryDirtySignal.notify}; this module adds NO body observer.
 *
 * What those observers cannot see is added by {@link GeometryDirtySignal.track},
 * and only once the parent has asked for geometry (a frame nobody indexes pays
 * nothing):
 *  - **the `<head>`**: a `<style>` rewritten by the class/authored-CSS injectors
 *    moves boxes without touching the body;
 *  - **`load`** (an image or stylesheet finishing), **font loading**
 *    (`document.fonts` `loadingdone`) and **`transitionend`/`animationend`**:
 *    layout moves with no DOM mutation at all;
 *  - **window `resize`**: a different viewport width reflows the page.
 *
 * ## A latch, not a stream
 *
 * `notify()` fires `onDirty` once, then goes quiet until {@link
 * GeometryDirtySignal.markClean} (called when the frame answers the next
 * `measureAll`). A live app mutating every frame therefore costs one message
 * per measurement, not one per mutation.
 */
import { isSelectionChromeMutation } from './selectionChromeMutation'

export interface GeometryDirtySignal {
  /** The parent asked for geometry: arm the head / load / font / resize listeners. Idempotent. */
  track(): void
  /** A fresh read was just taken: re-arm the latch. */
  markClean(): void
  /** The body observer saw a change that may move boxes. A no-op until `track()` and while already dirty. */
  notify(): void
  dispose(): void
}

export function createGeometryDirtySignal(doc: Document, view: Window & typeof globalThis, onDirty: () => void): GeometryDirtySignal {
  let tracking = false
  let dirty = false
  let disposed = false
  const releases: (() => void)[] = []

  const notify = (): void => {
    if (!tracking || dirty || disposed) return
    dirty = true
    onDirty()
  }

  const track = (): void => {
    if (tracking || disposed) return
    tracking = true
    const MutationObserverCtor = view.MutationObserver ?? MutationObserver
    if (doc.head) {
      try {
        // The editor's own chrome stylesheet is mounted in the head; that is not the page changing.
        const headObserver = new MutationObserverCtor((records) => {
          if (!records.every(isSelectionChromeMutation)) notify()
        })
        headObserver.observe(doc.head, { childList: true, subtree: true, characterData: true })
        releases.push(() => headObserver.disconnect())
      } catch (_err) {
        // A cross-realm node some browser realms refuse to observe: the body observer and the
        // listeners below still cover everything but a stylesheet rewrite.
      }
    }
    for (const type of ['load', 'transitionend', 'animationend']) {
      doc.addEventListener(type, notify, true)
      releases.push(() => doc.removeEventListener(type, notify, true))
    }
    view.addEventListener('resize', notify)
    releases.push(() => view.removeEventListener('resize', notify))
    const fonts = doc.fonts as FontFaceSet | undefined
    if (fonts && typeof fonts.addEventListener === 'function') {
      fonts.addEventListener('loadingdone', notify)
      releases.push(() => fonts.removeEventListener('loadingdone', notify))
    }
  }

  return {
    track,
    markClean() {
      dirty = false
    },
    notify,
    dispose() {
      disposed = true
      for (const release of releases) release()
      releases.length = 0
    },
  }
}
