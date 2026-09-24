/**
 * canvasSelectionMeasure — one layout read for a keyboard or menu command on
 * the selection, answered by whichever frame renders it (P2-C, generalised in
 * P5-E).
 *
 * The arrow keys (P2-C) were first to need "rects and a few computed
 * properties of these nodes, from the frame that shows them", and grew the
 * frame-picking logic inline in `measureArrowTargets`. Align (IX-20) and ⇧A
 * (IX-10) ask the same question, so it lives here once. It goes through the
 * frame ADAPTERS, so a live bridge frame answers it with one round trip just
 * as a portal frame answers it synchronously.
 */
import { listFrameAdapterRegistrations } from './frameAdapter/canvasFrameAdapterRegistry'
import type { NodeMeasurement } from './frameAdapter/FrameDocumentAdapter'

/**
 * Measure `refIds` (with `properties`, kebab-case CSS names) in the frame that
 * renders the page — the frame at `preferredBreakpointId` when one answers,
 * else the first that renders one of `anchorIds`. `null` when no mounted frame
 * renders any anchor. Keyed by node id; ids the frame could not find carry
 * `rect: null`.
 */
export async function measureInRenderingFrame(
  refIds: readonly string[],
  properties: readonly string[],
  preferredBreakpointId: string,
  anchorIds: readonly string[],
): Promise<Map<string, NodeMeasurement> | null> {
  const refs = [...new Set(refIds)].map((nodeId) => ({ nodeId }))
  const registrations = [...listFrameAdapterRegistrations().values()].sort(
    (a, b) => Number(b.breakpointId === preferredBreakpointId) - Number(a.breakpointId === preferredBreakpointId),
  )
  const answers = await Promise.all(
    registrations.map((registration) =>
      registration.adapter.measure(refs, [...properties]).catch((_err: unknown) => {
        // A bridge frame that does not answer in time (its dev server is
        // reloading) simply is not the frame this command reads.
        return null
      }),
    ),
  )
  const anchors = new Set(anchorIds)
  const answer = answers.find((candidate) =>
    candidate?.some((measurement) => measurement.rect && anchors.has(measurement.nodeId)),
  )
  if (!answer) return null
  return new Map(answer.map((measurement) => [measurement.nodeId, measurement]))
}
