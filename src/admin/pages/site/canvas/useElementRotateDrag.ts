/**
 * useElementRotateDrag — rotating the selected element by dragging just
 * outside a corner (P5-F, IX-25). Penpot's `start-rotate`
 * (`transforms.cljs:485-553`) in CSS terms.
 *
 * ## What it writes
 *
 * The STANDALONE `rotate` property, `style={{ rotate: '30deg' }}` — never a
 * `transform` function, so an authored transform survives, and never a second
 * rotation on top of one (`rotateValue.ts`). Back to 0° clears the
 * declaration rather than writing `0deg`. One `setNodeInlineStyles`: one undo
 * entry, one save.
 *
 * ## The geometry
 *
 * The angle is the pointer's angle about the element's centre, relative to
 * where the drag started, added to the rotation the element already has. The
 * centre is the centre of its bounding box, which for an element rotated
 * about its own centre (`rotate` uses `transform-origin`, `50% 50%` unless
 * authored otherwise) is the rotation centre itself. ⇧ snaps to 15°
 * (Penpot's and Figma's step). Rings stay axis-aligned: they measure
 * `getBoundingClientRect`, which is the box the rotated element covers.
 *
 * ## Refused
 *
 * Where the handles are refused (`canOfferResize` — the zones are drawn by
 * the same component), and where rotation already lives in `transform` or in
 * a `rotate` value a 2D gesture cannot continue (a 3D axis, a `var()`): an
 * info toast says why, and nothing is previewed.
 *
 * The plumbing — pointer capture, Escape, ERR-12, one write per frame, the
 * gesture freeze — is `handleDragSession.ts`, shared with resize.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { ROTATE_ACTIVE_ATTR, ROTATE_HANDLE_ATTR } from '@core/studio-runtime'
import { pushToast } from '@ui/components/Toast'
import {
  normalizeDegrees,
  parseRotateDegrees,
  rotateDeclaration,
  TRANSFORM_ROTATE_FN_RE,
} from '@site/panels/PropertiesPanel/rotateValue'
import { presentedElementForNode } from './canvasNodeLookup'
import { findNodeById } from './InPlaceInspector/findNodeById'
import { createInlineStylePreview } from './elementResizeInlinePreview'
import { startHandleDrag } from './handleDragSession'

/** ⇧ snaps the angle to multiples of this. */
export const ROTATE_SNAP_DEGREES = 15

interface Point {
  x: number
  y: number
}

/**
 * The element's rotation after the pointer went from `from` to `to` about
 * `center`, starting from `base` degrees; snapped to 15° steps when `snap`.
 * Folded into (-180, 180], one decimal.
 */
export function rotationAt(center: Point, from: Point, to: Point, base: number, snap: boolean): number {
  const start = Math.atan2(from.y - center.y, from.x - center.x)
  const now = Math.atan2(to.y - center.y, to.x - center.x)
  const degrees = base + ((now - start) * 180) / Math.PI
  const stepped = snap ? Math.round(degrees / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES : degrees
  return normalizeDegrees(stepped)
}

/**
 * Why this element cannot be rotated by the gesture, or `null`. `stored` is
 * the node's own inline styles; `computed` the element's computed `rotate`
 * and `transform`.
 */
export function rotateRefusal(
  stored: Record<string, unknown>,
  computed: { rotate: string; transform: string },
): string | null {
  const transform = typeof stored.transform === 'string' ? stored.transform : ''
  if (TRANSFORM_ROTATE_FN_RE.test(transform)) {
    return 'This layer is already rotated inside its transform. Edit it there, so there is not a second, conflicting rotation.'
  }
  const own = stored.rotate ?? computed.rotate
  if (parseRotateDegrees(own) === null) {
    return 'This layer’s rotation is not a plain angle (a 3D axis or a variable), so a drag cannot continue it.'
  }
  return null
}

/** A node with no `style={{…}}` of its own — stable, so no fallback object is built per press. */
const NO_INLINE_STYLES: Readonly<Record<string, unknown>> = {}

interface ElementRotateDragOptions {
  /** The handle frame portalled into the iframe overlay root, or `null`. */
  frame: HTMLElement | null
  iframeDoc: Document | null
  /** The single selected node, or `null` when rotation is not offered. */
  nodeId: string | null
}

export function useElementRotateDrag({ frame, iframeDoc, nodeId }: ElementRotateDragOptions): void {
  useEffect(() => {
    const view = iframeDoc?.defaultView
    if (!frame || !iframeDoc || !view || !nodeId) return

    const cleanups: Array<() => void> = []
    let cancelActive: (() => void) | null = null

    for (const zone of frame.querySelectorAll<HTMLElement>(`[${ROTATE_HANDLE_ATTR}]`)) {
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()

        const target = presentedElementForNode(iframeDoc, nodeId)
        if (!target) return
        const state = useEditorStore.getState()
        const stored = findNodeById(state, nodeId)?.inlineStyles ?? NO_INLINE_STYLES
        const computed = view.getComputedStyle(target)
        const refusal = rotateRefusal(stored, { rotate: computed.rotate, transform: computed.transform })
        if (refusal) {
          pushToast({ kind: 'info', title: 'This layer can’t be rotated here', body: refusal })
          return
        }

        const base = parseRotateDegrees(stored.rotate ?? computed.rotate) ?? 0
        const box = target.getBoundingClientRect()
        const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        const from = { x: event.clientX, y: event.clientY }
        const preview = createInlineStylePreview(target)
        let angle = normalizeDegrees(base)

        cancelActive = startHandleDrag({
          event,
          handleEl: zone,
          frame,
          activeAttr: ROTATE_ACTIVE_ATTR,
          iframeDoc,
          scaleTool: false,
          callbacks: {
            step: (dx, dy, modifiers) => {
              angle = rotationAt(center, from, { x: from.x + dx, y: from.y + dy }, base, modifiers.proportional)
            },
            paint: () => {
              preview.apply({ rotate: rotateDeclaration(angle) ?? '0deg' })
            },
            end: (commit) => {
              cancelActive = null
              preview.clear()
              if (!commit || angle === normalizeDegrees(base)) return
              useEditorStore.getState().setNodeInlineStyles(nodeId, { rotate: rotateDeclaration(angle) })
            },
          },
        })
      }
      zone.addEventListener('pointerdown', onPointerDown)
      cleanups.push(() => zone.removeEventListener('pointerdown', onPointerDown))
    }

    return () => {
      cancelActive?.()
      for (const cleanup of cleanups) cleanup()
    }
  }, [frame, iframeDoc, nodeId])
}
