/**
 * placeDrawOnBoard — an armed R / O / T draw released on the EMPTY board
 * becomes a loose layer on the free canvas (P5-G, OD-14), at the drawn rect.
 *
 * The element is spelled exactly as the same tool's insert into a frame spells
 * it (`moduleSourceElement` + `drawInsertStyles`), so a rectangle drawn on the
 * board and the same rectangle drawn in a frame are the same JSX. The board is
 * not scaled, so the drawn size is written in board units as-is (scale 1).
 *
 * A text opens for editing at once (`whenLayerReady`).
 *
 * A board click with a size-less tool (text) writes the module's natural
 * content; a click with a box tool gets Figma's 100 × 100, the way a click in
 * a frame does.
 */
import { useEditorStore } from '@site/store/store'
import { moduleSourceElement } from '@site/store/slices/site/moduleSourceElement'
import { DRAW_TOOL_SPECS, drawInsertStyles, type DrawRect } from './canvasDrawTool'
import type { DrawTool } from '@site/store/slices/canvasSlice'
import { projectBodyTextStyles } from './projectTextDefaults'
import { startLayerTextEdit, whenLayerReady } from './BoardCanvasLayer/canvasLayerTextEdit'

/** Create the loose layer. True when one was created (no active board → false). */
export function placeDrawOnBoard(tool: DrawTool, boardRect: DrawRect, dragged: boolean): boolean {
  const spec = DRAW_TOOL_SPECS[tool]
  // A loose text inherits nothing: give it the project's body typography.
  const styles = {
    ...(tool === 'text' ? projectBodyTextStyles() : {}),
    ...drawInsertStyles(spec, dragged ? boardRect : null, 1),
  }
  const element = moduleSourceElement(spec.moduleId, undefined, styles)
  if (!element) return false
  const { intrinsic: _intrinsic, ...layerElement } = element
  const layerId = useEditorStore.getState().createCanvasLayer(layerElement, { x: boardRect.x, y: boardRect.y })
  if (layerId === null) return false
  // Once its module has been written and read back: the new layer is the
  // selection (its ring, its Properties), and a text opens for typing with its
  // placeholder selected, the way one drawn in a frame does.
  whenLayerReady(layerId, () => {
    useEditorStore.getState().selectCanvasLayer(layerId)
    if (spec.moduleId === 'base.text') startLayerTextEdit(layerId, undefined, { selectAll: true })
  })
  return true
}
