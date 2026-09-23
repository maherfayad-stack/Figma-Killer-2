/**
 * measureNodes — answers a `measure` request: rects + a bounded set of
 * computed-style properties for a list of stamped node refs.
 *
 * Split out of `runtime.ts` (`speed-06`) purely to keep that module under
 * the 700-line module-size ceiling once the sibling `dropCandidates` dispatch
 * was added — the two are thematically close (both enumerate/measure nodes
 * for the parent) so this is a clean seam, not an arbitrary one.
 */
import { findNthNodeById } from './nodeIdIndexing'
import { rectRelativeToBody } from './nodeDom'
import type { NodeMeasurement } from './messages'

/** The computed-style properties a `measure` request gets when it doesn't name its own. */
export const DEFAULT_MEASURED_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'opacity',
]

export function measureNodes(
  doc: Document,
  view: Window,
  refs: readonly { nodeId: string; occurrenceIndex: number }[],
  properties: readonly string[] | undefined,
): NodeMeasurement[] {
  const props = properties?.length ? properties : DEFAULT_MEASURED_PROPERTIES
  return refs.map(({ nodeId, occurrenceIndex }) => {
    const el = findNthNodeById(doc, nodeId, occurrenceIndex)
    if (!el || !doc.body) return { nodeId, occurrenceIndex, rect: null, computedStyle: {} }
    const rect = rectRelativeToBody(el, doc.body)
    const computed = view.getComputedStyle(el)
    const computedStyle: Record<string, string> = {}
    for (const prop of props) computedStyle[prop] = computed.getPropertyValue(prop)
    return { nodeId, occurrenceIndex, rect, computedStyle }
  })
}
