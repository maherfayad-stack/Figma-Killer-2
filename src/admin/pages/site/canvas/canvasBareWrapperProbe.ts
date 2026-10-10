/**
 * canvasBareWrapperProbe — is a container a full-frame wrapper with no paint?
 *
 * Imported app screens wrap their whole page in one or two `<div>`s that only
 * lay children out. Every blank point of the page hits such a wrapper, so a
 * press-drag there must sweep a marquee rather than move the wrapper
 * (`isFrameBackgroundHit`). The tree cannot say whether a wrapper paints
 * anything, so this reads the frame document: one computed-style read per
 * probed node, only at pointerdown.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import { nodeVisualRect, type ClientRectLike } from './canvasDomGeometry'
import { presentedElementForNode } from './canvasNodeLookup'
import { frameContentRootId } from './canvasPressTarget'

/** Share of the frame's width and height a wrapper must cover to count as "full-frame". */
const FULL_FRAME_COVERAGE = 0.9

/** The computed paint properties that make a box visible on its own. */
export interface ComputedPaint {
  backgroundColor: string
  backgroundImage: string
  boxShadow: string
  borderTopWidth: string
  borderRightWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
}

function isTransparentColor(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (value === 'transparent') return true
  const match = /^rgba?\((.*)\)$/.exec(value)
  if (!match) return false
  const channels = match[1]!.split(/[\s,/]+/).filter(Boolean)
  return channels.length >= 4 && Number(channels[3]) === 0
}

/** True when the box draws nothing itself: no fill, image, shadow or border. */
export function isUnpainted(paint: ComputedPaint): boolean {
  const noBorder = [paint.borderTopWidth, paint.borderRightWidth, paint.borderBottomWidth, paint.borderLeftWidth]
    .every((width) => parseFloat(width) === 0 || width === '')
  return (
    isTransparentColor(paint.backgroundColor) &&
    (paint.backgroundImage === 'none' || paint.backgroundImage === '') &&
    (paint.boxShadow === 'none' || paint.boxShadow === '') &&
    noBorder
  )
}

/** True when `box` covers (nearly) all of `frame`. */
export function coversFrame(box: ClientRectLike, frame: ClientRectLike): boolean {
  return box.width >= frame.width * FULL_FRAME_COVERAGE && box.height >= frame.height * FULL_FRAME_COVERAGE
}

/** A probe over one frame document and its page tree. */
export function createBareWrapperProbe(doc: Document, tree: NodeTree<PageNode>): (nodeId: string) => boolean {
  const view = doc.defaultView
  // Measured on the first probe, not at creation: most presses never ask.
  let frameRect: ClientRectLike | null | undefined
  return (nodeId) => {
    if (frameRect === undefined) {
      const contentRoot = presentedElementForNode(doc, frameContentRootId(tree))
      frameRect = contentRoot ? nodeVisualRect(contentRoot) : null
    }
    if (!view || !frameRect) return false
    const element = presentedElementForNode(doc, nodeId)
    const rect = element ? nodeVisualRect(element) : null
    if (!element || !rect || !coversFrame(rect, frameRect)) return false
    const style = view.getComputedStyle(element)
    return isUnpainted(style)
  }
}
