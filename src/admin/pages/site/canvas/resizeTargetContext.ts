/**
 * resizeTargetContext — what a live (bridge) frame's resize needs from the
 * store, read as primitives for `useBridgeResizeTarget` and assembled into
 * the adapter's `ResizeTargetOptions`.
 *
 * A portal drag reads all of this off the store at pointerdown
 * (`useElementResizeDrag.ts`). The live frame's handles run inside a
 * cross-origin document with no store, so the parent sends it with the
 * target instead:
 *
 *  - the node's STORED sizing markers (`flex`, `alignSelf`, `justifySelf`) —
 *    what `sizingPatch('fixed')` reads to decide which Fill marker a resize
 *    clears (canvas-23 / IX-6b);
 *  - the node's tree siblings and tree parent — the snap peers (canvas-26 /
 *    IX-6e). The TREE's, because the frame's DOM cannot say which stamped
 *    elements are this node's siblings in the page;
 *  - the committed zoom, for the screen-px snap threshold (IX-5a).
 *
 * The selectors return strings, so a store write that changes none of them
 * re-sends nothing: a selector returning a fresh object would re-render the
 * overlay on every store change.
 */
import type { OffsetProperty, ResizeAnchors, ResizeSizingMarkers } from '@core/studio-runtime'
import type { EditorStore } from '@site/store/store'
import type { ResizeTargetOptions } from './frameAdapter/FrameDocumentAdapter'
import { authoredOffsets } from './canvasNodeArrowMove'
import { findNodeById } from './InPlaceInspector/findNodeById'

/** The markers, in the order `resizeTargetOptions` reads them back. */
const MARKER_KEYS = ['flex', 'alignSelf', 'justifySelf'] as const
type MarkerKey = (typeof MARKER_KEYS)[number]

/** Longer than the wire takes (`resizeMessages.ts`), and longer than any value the Fixed switch recognises — so never worth sending. */
const MARKER_MAX = 64

/** One stored sizing marker of `nodeId`, as the string the source spells; `undefined` when absent or not a marker at all. */
export function storedSizingMarker(state: EditorStore, nodeId: string | null, key: MarkerKey): string | undefined {
  if (!nodeId) return undefined
  const value = findNodeById(state, nodeId)?.inlineStyles?.[key]
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value)
  return text.length <= MARKER_MAX ? text : undefined
}

/** `nodeId`'s tree parent and its other children, one id per line, parent first — `''` when it has no parent. */
export function resizeSnapPeersKey(state: EditorStore, nodeId: string | null): string {
  if (!nodeId) return ''
  const parentId = findNodeById(state, nodeId)?.parentId
  const parent = parentId ? findNodeById(state, parentId) : null
  if (!parent) return ''
  return [parent.id, ...parent.children.filter((id) => id !== nodeId)].join('\n')
}

const HORIZONTAL_ANCHORS: readonly OffsetProperty[] = ['left', 'right', 'insetInlineStart', 'insetInlineEnd']

/**
 * PA-8 — the offsets `nodeId`'s source authors (its class rules, then its
 * inline style), as a string so an unrelated store write re-sends nothing:
 * horizontal ones, `|`, vertical ones. `''` when the node is not found.
 */
export function resizeAnchorsKey(state: EditorStore, nodeId: string | null): string {
  const node = nodeId ? findNodeById(state, nodeId) : null
  if (!node) return ''
  const authored = authoredOffsets(node, state.site?.styleRules)
  const horizontal = HORIZONTAL_ANCHORS.filter((property) => authored.has(property))
  const vertical = (['top', 'bottom'] as const).filter((property) => authored.has(property))
  return `${horizontal.join(',')}|${vertical.join(',')}`
}

function anchorsOf(key: string): ResizeAnchors | undefined {
  if (key === '') return undefined
  const [horizontal = '', vertical = ''] = key.split('|')
  const list = (text: string) => (text === '' ? [] : (text.split(',') as OffsetProperty[]))
  return { horizontal: list(horizontal), vertical: list(vertical) }
}

/** The adapter options for a resize target, from the primitives above. */
export function resizeTargetOptions(input: {
  proportional: boolean
  markers: readonly [string | undefined, string | undefined, string | undefined]
  snapPeers: string
  anchors: string
  zoom: number
}): ResizeTargetOptions {
  const sizing: ResizeSizingMarkers = {}
  MARKER_KEYS.forEach((key, index) => {
    const value = input.markers[index]
    if (value !== undefined) sizing[key] = value
  })
  const [parentId, ...siblingIds] = input.snapPeers === '' ? [] : input.snapPeers.split('\n')
  const anchors = anchorsOf(input.anchors)
  return {
    proportional: input.proportional,
    sizing,
    ...(anchors ? { anchors } : {}),
    snap: {
      siblings: siblingIds.map((nodeId) => ({ nodeId })),
      parent: parentId ? { nodeId: parentId } : null,
      // The wire refuses a zoom it cannot divide by — and a refused
      // `setResizeTarget` would take the handles with it.
      zoom: Number.isFinite(input.zoom) && input.zoom > 0 ? Math.min(input.zoom, 256) : 1,
    },
  }
}
