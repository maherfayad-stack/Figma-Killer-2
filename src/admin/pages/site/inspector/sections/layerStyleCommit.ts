/**
 * layerStyleCommit - a loose layer's style gesture = one `style` write.
 *
 * Same shape as `vectorPaintCommit.ts`, for the same reason: a colour picker or
 * a scrub reports every value it passes through, and posting each would be dozens
 * of `/save` round trips and undo entries for what the user sees as ONE change.
 * So a burst of edits to the same layer is mirrored straight onto the rendered
 * element (the canvas moves with the hand), coalesced, and posted once,
 * {@link BURST_SETTLE_MS} after the last edit, carrying the values from BEFORE
 * the burst as its inverse. A discrete edit (a typed value) flushes at once.
 *
 * The write rides `commitStructural` (the editor's `/save`, the only batch
 * allowed to write a layer module) with a `known` inverse: the same `style` edit
 * with the previous values, and `remove` for the properties that were absent.
 */
import { camelToKebabCssProperty } from '@core/css-codemods/browser'
import { mintPendingCommitId } from '@site/store/slices/site/structuralCommitRollback'
import { commitStructural } from '@site/studio/studioStructuralCommitEngine'
import type { StructuralEditPayload } from '@site/studio/structuralUndoPlan'
import { findRenderedCanvasElements } from '@site/canvas/canvasNodeLookup'
import type { LayerStyleChange } from './layerStyleModel'

/** How long after the last edit a burst is posted - the vector burst's own figure. */
export const BURST_SETTLE_MS = 400

interface Burst {
  nodeId: string
  label: string
  set: Record<string, string>
  remove: Set<string>
  /** The value each touched property held BEFORE the burst (`undefined` = absent). */
  previous: Map<string, string | number | undefined>
  timer: ReturnType<typeof setTimeout> | null
}

function mirror(nodeId: string, property: string, value: string | null): void {
  for (const { element } of findRenderedCanvasElements(nodeId)) {
    const style = (element as HTMLElement).style
    if (value === null) style.removeProperty(camelToKebabCssProperty(property))
    else style.setProperty(camelToKebabCssProperty(property), value)
  }
}

function forward(burst: Burst): StructuralEditPayload {
  return { kind: 'style', nodeId: burst.nodeId, style: { ...burst.set }, ...(burst.remove.size > 0 ? { remove: [...burst.remove] } : {}) }
}

function inverse(burst: Burst): StructuralEditPayload {
  const style: Record<string, string | number> = {}
  const remove: string[] = []
  for (const [property, before] of burst.previous) {
    if (before === undefined) remove.push(property)
    else style[property] = before
  }
  return { kind: 'style', nodeId: burst.nodeId, style, ...(remove.length > 0 ? { remove } : {}) }
}

/** A per-panel coalescer: `push` previews and queues, `flush` posts what is queued. */
export function createLayerStyleCommitter() {
  let burst: Burst | null = null

  const flush = () => {
    const current = burst
    burst = null
    if (!current) return
    if (current.timer !== null) clearTimeout(current.timer)
    if (Object.keys(current.set).length === 0 && current.remove.size === 0) return
    const restore = () => {
      for (const [property, before] of current.previous) mirror(current.nodeId, property, before === undefined ? null : String(before))
    }
    let done = false
    void commitStructural([forward(current)], 'Edit refused', {
      undo: { label: current.label, template: { kind: 'known', inverse: [inverse(current)] } },
      rollback: {
        id: mintPendingCommitId(),
        settle: () => {
          done = true
        },
        rollback: () => {
          if (done) return
          done = true
          restore()
        },
      },
    })
  }

  const push = (
    nodeId: string,
    change: LayerStyleChange,
    previous: Readonly<Record<string, string | number | undefined>>,
    label: string,
    settle: 'burst' | 'now',
  ) => {
    if (burst && burst.nodeId !== nodeId) flush()
    burst ??= { nodeId, label, set: {}, remove: new Set(), previous: new Map(), timer: null }
    burst.label = label
    for (const [property, value] of Object.entries(change.set)) {
      burst.set[property] = value
      burst.remove.delete(property)
      if (!burst.previous.has(property)) burst.previous.set(property, previous[property])
      mirror(nodeId, property, value)
    }
    for (const property of change.remove) {
      delete burst.set[property]
      burst.remove.add(property)
      if (!burst.previous.has(property)) burst.previous.set(property, previous[property])
      mirror(nodeId, property, null)
    }
    if (burst.timer !== null) clearTimeout(burst.timer)
    burst.timer = null
    if (settle === 'now') flush()
    else burst.timer = setTimeout(flush, BURST_SETTLE_MS)
  }

  return { push, flush }
}
