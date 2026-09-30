/**
 * CanvasLayerInspector — the Properties panel body while loose layers on the
 * free canvas are selected (P5-G's fourth selection list,
 * `canvasLayerSlice.selectedCanvasLayerIds`), as `FrameBulkInspector` is for
 * frames. Before it the panel closed on a loose-layer selection, so a vector
 * drawn with the pen on the empty board had no fill or stroke control at all
 * (owner report: "in svg I can't control the fill").
 *
 * What it edits is the layer's ROOT element, the one element its module
 * returns. A root `<svg>` gets the same Vector controls as a `<svg>` in a
 * frame: its node lives in the layer's own `canvas:<id>` page, and the
 * `svg-attr` write lands in `.studio/canvas/<id>.tsx` through the editor's
 * `/save` (the only batch allowed to write a layer module — FC-1). Any other
 * root says plainly that its properties are edited inside a frame for now
 * (FC-7, `docs/features/free-canvas.md`), rather than showing controls that
 * would write to the wrong document.
 */
import { useEditorStore } from '@site/store/store'
import { canvasLayerPageId } from '@core/studio-board'
import { Section } from '@ui/components/Section'
import { canvasLayerRootNodeId } from '@site/store/slices/canvasLayerGestures'
import { VectorPaintControls } from '@site/inspector/sections/VectorPaintControls'
import styles from './CanvasLayerInspector.module.css'

export function CanvasLayerInspector() {
  const selected = useEditorStore((s) => s.selectedCanvasLayerIds)
  const layerPage = useEditorStore((s) => (s.selectedCanvasLayerIds.length === 1 ? s.canvasLayerPages[canvasLayerPageId(s.selectedCanvasLayerIds[0]!)] : undefined))

  if (selected.length !== 1) {
    return (
      <div className={styles.panel} data-testid="canvas-layer-inspector">
        <p className={styles.note}>{selected.length} loose layers selected. Select one to edit it.</p>
      </div>
    )
  }

  const rootId = layerPage ? canvasLayerRootNodeId(layerPage) : null
  const root = rootId ? layerPage?.nodes[rootId] : undefined
  if (!rootId || !root) {
    return (
      <div className={styles.panel} data-testid="canvas-layer-inspector">
        <p className={styles.note}>This loose layer’s file is still loading.</p>
      </div>
    )
  }

  if (root.moduleId === 'base.svg') {
    return (
      <div data-testid="canvas-layer-inspector">
        <Section title="Vector" forceOpen>
          <VectorPaintControls key={rootId} nodeId={rootId} node={root} />
        </Section>
      </div>
    )
  }

  return (
    <div className={styles.panel} data-testid="canvas-layer-inspector">
      <p className={styles.note}>
        A loose layer’s styles are edited inside a frame for now: drag it into one, edit it there, and drag it back out if
        you want it on the board.
      </p>
    </div>
  )
}
