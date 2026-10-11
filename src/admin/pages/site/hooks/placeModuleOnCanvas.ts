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
import { CANVAS_LAYER_DIR } from '@core/studio-board'
import { relativeImportSpecifier } from '@site/property-controls/relativeImportSpecifier'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { moduleSourceElement } from '@site/store/slices/site/moduleSourceElement'
import { useEditorStore } from '@site/store/store'

/** The edge, in CSS px, a Div or Span dropped on the empty board is written at. The insertion ghost draws the same box. */
export const EMPTY_BOX_EDGE_PX = 100
const EMPTY_BOX_SIZE: Record<string, string> = { width: `${EMPTY_BOX_EDGE_PX}px`, height: `${EMPTY_BOX_EDGE_PX}px` }

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

/**
 * A component declared in the user's OWN project, dropped on the empty board.
 * It has no registry module, so the layer's root is spelled the way
 * `insertProjectComponent` spells it in a page — `<Card />` plus an import —
 * with the specifier relative to the layer module (every layer sits directly
 * in `.studio/canvas/`, so the specifier does not depend on the layer's id).
 * Its size comes from the component itself; the layer is not given a box.
 */
export function placeProjectComponentOnCanvas(
  component: LocalComponentSpec,
  at: { x: number; y: number },
): boolean {
  const element = {
    name: component.exportName,
    importSpecifier: relativeImportSpecifier(`${CANVAS_LAYER_DIR}/layer.tsx`, component.file),
    ...(component.isDefaultExport ? { importStyle: 'default' as const } : {}),
    props: {},
  }
  return useEditorStore.getState().createCanvasLayer(element, at) !== null
}
