/**
 * placeModuleOnCanvas — a registry module dropped on the EMPTY board becomes a
 * loose layer (P5-G G1, OD-14's free canvas): one `.studio/canvas/<id>.tsx`
 * module whose root is the element, placed with its top-left at the drop
 * point. Never part of a page, the live preview or a publish; it can be
 * dragged into a frame later (`placeCanvasLayer`).
 *
 * The element is spelled exactly as an insert into a page would spell it
 * (`moduleSourceElement`), so a Button dropped on the board and the same
 * Button dropped in a frame are the same JSX.
 *
 * One addition only the board needs: an empty intrinsic box (a Div or a Span
 * from the notch, a Container card) has no content to give it a size, and a
 * zero-size loose layer is invisible and cannot be grabbed. It is written at
 * `EMPTY_BOX_SIZE`, the way the frame tool writes the size you drew.
 */
import { moduleSourceElement } from '@site/store/slices/site/moduleSourceElement'
import { useEditorStore } from '@site/store/store'

const EMPTY_BOX_SIZE: Record<string, string> = { width: '100px', height: '100px' }

/** Whether `moduleId` has a spelling a loose layer can hold — the drag asks this once, to decide whether to offer the board. */
export function canPlaceModuleOnCanvas(moduleId: string, defaults?: Record<string, unknown>): boolean {
  return moduleSourceElement(moduleId, defaults) !== null
}

/** Put `moduleId` on the active board at `at` (board units). True when a layer was created. */
export function placeModuleOnCanvas(
  moduleId: string,
  defaults: Record<string, unknown> | undefined,
  at: { x: number; y: number },
): boolean {
  const probe = moduleSourceElement(moduleId, defaults)
  if (!probe) return false
  const element = probe.intrinsic && probe.children === undefined ? moduleSourceElement(moduleId, defaults, EMPTY_BOX_SIZE) : probe
  if (!element) return false
  const { intrinsic: _intrinsic, ...spec } = element
  return useEditorStore.getState().createCanvasLayer(spec, at) !== null
}
