/**
 * vectorPaintCommit — one Vector-section gesture = one `svg-attr` write.
 *
 * A colour picker reports every hue it passes through while it is dragged,
 * and a scrub field every step. Posting each of those would be dozens of
 * `/save` round trips and dozens of undo entries for what the user sees as
 * ONE change. So a burst of edits to the same graphic is coalesced: each edit
 * is mirrored straight onto the rendered element (a preview — the canvas moves
 * with the hand), and the burst is posted once, {@link BURST_SETTLE_MS} after
 * the last edit, carrying the values from BEFORE the burst as its inverse.
 * A discrete edit (a menu choice, a typed value) flushes at once.
 *
 * The preview is imperative DOM on the in-frame `<svg>`: React owns the root's
 * attributes and the inner markup, and re-applies both when the write's
 * resync lands. A write that does not land puts the previewed attributes back
 * by hand, because nothing else would (`commitSvgPartAttributes`'s
 * `onNotLanded`). Portal frames only — a live bridge frame's document is not
 * ours to touch, and there the write simply shows when it lands.
 */
import { SVG_PART_ATTRIBUTE, jsxToMarkupAttributeName } from '@core/vector'
import { commitSvgPartAttributes, type SvgPartWrite } from '@site/studio/svgPartCommits'
import { findRenderedCanvasElements } from '@site/canvas/canvasNodeLookup'

/** How long after the last edit a burst is posted — the vector-edit nudge burst's own figure. */
export const BURST_SETTLE_MS = 400

interface PreviewedAttribute {
  element: Element
  name: string
  before: string | null
}

interface Burst {
  hostNodeId: string
  label: string
  /** One entry per `part|attribute`: the latest value, the FIRST previous. */
  writes: Map<string, SvgPartWrite>
  previewed: PreviewedAttribute[]
  timer: ReturnType<typeof setTimeout> | null
}

function writeKey(write: SvgPartWrite): string {
  return `${write.part}|${[...Object.keys(write.set), ...(write.remove ?? [])].join(',')}`
}

/** Whether `write` leaves every attribute it names exactly as it was. */
function isNetNoop(write: SvgPartWrite): boolean {
  const setSame = Object.entries(write.set).every(([name, value]) => {
    const before = write.previous[name]
    return before !== undefined && String(before) === String(value)
  })
  const removeSame = (write.remove ?? []).every((name) => write.previous[name] === undefined)
  return setSame && removeSame
}

function escapeAttribute(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

/** Mirror `write` onto every rendered copy of its element; remember what each attribute held first. */
function preview(write: SvgPartWrite, previewed: PreviewedAttribute[]): void {
  for (const { element: host } of findRenderedCanvasElements(write.hostNodeId)) {
    const element = write.part === '' ? host : host.querySelector(`[${SVG_PART_ATTRIBUTE}="${escapeAttribute(write.part)}"]`)
    if (!element) continue
    const apply = (jsxName: string, value: string | null) => {
      const name = jsxToMarkupAttributeName(jsxName)
      if (!previewed.some((entry) => entry.element === element && entry.name === name)) {
        previewed.push({ element, name, before: element.getAttribute(name) })
      }
      if (value === null) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
    for (const [name, value] of Object.entries(write.set)) apply(name, String(value))
    for (const name of write.remove ?? []) apply(name, null)
  }
}

function restore(previewed: readonly PreviewedAttribute[]): void {
  for (const { element, name, before } of [...previewed].reverse()) {
    if (before === null) element.removeAttribute(name)
    else element.setAttribute(name, before)
  }
}

/**
 * A per-panel coalescer. `push` previews and queues; `flush` posts whatever is
 * queued. A push for a different graphic (the selection moved mid-burst)
 * flushes the old burst first, so a burst never mixes two hosts.
 */
export function createVectorPaintCommitter() {
  let burst: Burst | null = null

  const flush = () => {
    const current = burst
    burst = null
    if (!current) return
    if (current.timer !== null) clearTimeout(current.timer)
    const writes = [...current.writes.values()]
    if (writes.length === 0) return
    void commitSvgPartAttributes(writes, current.label, () => restore(current.previewed))
  }

  const push = (hostNodeId: string, writes: readonly SvgPartWrite[], label: string, settle: 'burst' | 'now') => {
    if (writes.length === 0) return
    if (burst && burst.hostNodeId !== hostNodeId) flush()
    burst ??= { hostNodeId, label, writes: new Map(), previewed: [], timer: null }
    burst.label = label
    for (const write of writes) {
      const key = writeKey(write)
      const earlier = burst.writes.get(key)
      const merged = earlier ? { ...write, previous: earlier.previous } : write
      // Back where the burst started: nothing to post for this attribute.
      if (isNetNoop(merged)) burst.writes.delete(key)
      else burst.writes.set(key, merged)
      preview(write, burst.previewed)
    }
    if (burst.timer !== null) clearTimeout(burst.timer)
    burst.timer = null
    if (settle === 'now') flush()
    else burst.timer = setTimeout(flush, BURST_SETTLE_MS)
  }

  return { push, flush }
}

export type VectorPaintCommitter = ReturnType<typeof createVectorPaintCommitter>
