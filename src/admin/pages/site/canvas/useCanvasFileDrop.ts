/**
 * useCanvasFileDrop — D2 G15's gesture: an image file dragged in from the
 * operating system and dropped on a board frame.
 *
 * ## One gesture, one write, one toast
 *
 * `planCanvasFileDrop` decides everything that can go wrong before the network
 * is touched, and each of its refusals is one toast with a sentence and no
 * write. A drop that IS good makes exactly two calls — land the bytes, then
 * one structural commit — and the success toast is the commit's own, so the
 * user never gets two for one gesture.
 *
 * ## Why the listeners are on `window`, not on the canvas root
 *
 * A native `dragover`/`drop` does NOT cross the iframe boundary (the canvas
 * rule every event bridge in this folder exists for), and a frame is exactly
 * where the interesting drops land. `useIframeEventForwarding` re-dispatches
 * the pair on the iframe ELEMENT in the parent document, so a drop over a
 * frame arrives here having bubbled from inside that frame — which only works
 * if the listener is above every frame. `window` is that place, and the plan
 * function's own frame hit-test is what keeps the gesture scoped to the board.
 *
 * ## `dragover` must be cancelled or `drop` never fires
 *
 * A browser's default for a dragover it does not recognise is "no drop here",
 * and `drop` is simply not delivered. Cancelling it is the ONLY way to accept
 * a file — and it is cancelled only for a drag that actually carries files, so
 * an ordinary in-page HTML5 drag (the DOM panel's layer tree still uses
 * `@dnd-kit`) is left entirely alone.
 */
import { useEffect } from 'react'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { lookupCanvasPageById, useEditorStore } from '@site/store/store'
import { dropStudioAsset } from '@site/studio/dropStudioAsset'
import { planCanvasFileDrop } from './canvasFileDrop'
import type { CanvasTransform } from './math'

/** Title every refusal and every failure of this gesture shares. */
const DROP_TITLE = 'Cannot add that image'

interface UseCanvasFileDropOptions {
  /** Off entirely without structural edit rights — a read-only session writes nothing. */
  enabled: boolean
  /** D1's live canvas transform, for the frame rects the plan hit-tests against. */
  transformRef?: React.RefObject<CanvasTransform>
}

/** True when this drag is carrying files from outside the browser. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes('Files')
}

export function useCanvasFileDrop({ enabled, transformRef }: UseCanvasFileDropOptions): void {
  useEffect(() => {
    if (!enabled) return

    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return
      // Without this the browser refuses the drop outright and `drop` never
      // fires at all — see this module's own doc.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer
      if (!carriesFiles(transfer)) return
      event.preventDefault()

      const plan = planCanvasFileDrop({
        files: Array.from(transfer?.files ?? []),
        point: { x: event.clientX, y: event.clientY },
        transform: transformRef?.current ?? null,
        readPage: (pageId) => {
          const site = useEditorStore.getState().site
          return site ? lookupCanvasPageById(site, pageId) : null
        },
      })

      if (!plan.ok) {
        pushToast({
          kind: 'warning',
          title: DROP_TITLE,
          body: plan.refusal.message,
          location: 'site-editor',
          // Dropping the same wrong thing twice is one fact, not two cards.
          dedupeKey: `canvas-file-drop:${plan.refusal.reason}`,
        })
        return
      }

      void landAndInsert(plan.file, plan.pageId, plan.target.parentId, plan.target.index)
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [enabled, transformRef])
}

/**
 * The two calls a good drop makes. Separate from the listener so the failure
 * of the FIRST one (the upload) is reported with the server's own sentence
 * rather than folded into the structural commit's refusal channel — they fail
 * for genuinely different reasons and only one of them is about the user's
 * source.
 */
async function landAndInsert(file: File, pageId: string, parentId: string, index: number): Promise<void> {
  let src: string
  try {
    src = (await dropStudioAsset(file)).src
  } catch (err) {
    console.error('[canvas-file-drop] landing the dropped image failed:', err)
    pushToast({
      kind: 'error',
      title: DROP_TITLE,
      body: getErrorMessage(err, 'The image could not be written into your project.'),
      location: 'site-editor',
    })
    return
  }
  useEditorStore.getState().insertImageIntoPage(pageId, parentId, index, { src, alt: altTextFor(file) })
}

/**
 * The `alt` a dropped image starts with: its own file name without the
 * extension. A placeholder the inspector fixes — but an `<img>` with NO `alt`
 * is a real accessibility defect written into someone's repository, and an
 * empty one asserts the image is decorative, which Studio cannot know.
 */
function altTextFor(file: File): string {
  const base = file.name.replace(/\.[^./\\]+$/, '').trim()
  return base.length > 0 ? base : 'Image'
}
