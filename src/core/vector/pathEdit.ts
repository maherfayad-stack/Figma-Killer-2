/**
 * pathEdit — the edits that change a path's SHAPE LIST rather than moving a
 * point (P5-D, SVG-6): add an anchor, remove one, make one a corner or smooth.
 *
 * `pathModel.ts`'s minimal re-emit works because its model and the source
 * segments stay aligned one-to-one. These edits break that alignment — a split
 * turns one segment into two, a removal turns two into one — so each is done
 * in two steps, and the second is the same minimal re-emit as a drag:
 *
 *   1. splice the SOURCE: replace the affected segments with synthesised ones
 *      (in the source's own relative/absolute form), leaving every other
 *      source segment — its text included — exactly as it was;
 *   2. re-derive a model from the spliced source, put every LATER segment back
 *      at its original absolute geometry (a relative `l`/`m` after the edit
 *      must still land where it did), and serialise.
 *
 * So a split rewrites exactly the segment it split, a removal exactly the
 * segments it merged, and a relative segment after the edit only when its
 * start point truly moved. An implicit repeat whose implied command changed
 * gains its letter; an `S`/`T` whose reflection no longer holds becomes
 * `C`/`Q` — both `serializePathModel`'s own rules.
 *
 * Arcs are refused (`null`): splitting or merging an arc exactly needs an
 * explicit "convert to curve" first (`arcToCubic.ts`).
 */
import type { PathCommand, PathData, PathSegment } from './pathData'
import { createPathModel, serializePathModel, type AbsoluteSegment, type PathModel } from './pathModel'
import { distance, lerpPoint, quadToCubic, splitCubic, splitQuad, type Point } from './pathGeometry'
import { formatPathNumber } from './precision'

/** The kinds a synthesised segment can be. */
type SynthKind = 'line' | 'cubic' | 'quad' | 'move'

interface Synth {
  kind: SynthKind
  from: Point
  to: Point
  c1?: Point
  c2?: Point
  relative: boolean
  /** A line written as `H`/`V` in the source stays one when it still can. */
  axis?: 'H' | 'V'
}

const LETTER: Record<SynthKind, string> = { line: 'L', cubic: 'C', quad: 'Q', move: 'M' }

function round(p: Point, decimals: number): Point {
  return { x: Number(formatPathNumber(p.x, decimals)), y: Number(formatPathNumber(p.y, decimals)) }
}

function isRelative(command: PathCommand): boolean {
  return command === command.toLowerCase()
}

/** One synthesised source segment, its values and text consistent with each other. */
function synthesise(synth: Synth, decimals: number): PathSegment {
  const base = synth.relative ? synth.from : { x: 0, y: 0 }
  const rel = (p: Point): number[] => [p.x - base.x, p.y - base.y]
  const points = synth.kind === 'cubic' ? [synth.c1!, synth.c2!, synth.to] : synth.kind === 'quad' ? [synth.c1!, synth.to] : [synth.to]
  const axis = synth.kind === 'line' ? keptAxis(synth) : undefined
  const all = points.flatMap(rel)
  const values = (axis === 'H' ? [all[0]!] : axis === 'V' ? [all[1]!] : all).map((v) => Number(formatPathNumber(v, decimals)))
  const upper = axis ?? LETTER[synth.kind]
  const letter = synth.relative ? upper.toLowerCase() : upper
  const text = ` ${letter}${values.map((v) => formatPathNumber(v, decimals)).join(' ')}`
  return { command: letter as PathCommand, values, implicit: false, lead: ' ', text, decimals }
}

/** `H`/`V` when the source wrote one and the line is still axis-aligned. */
function keptAxis(synth: Synth): 'H' | 'V' | undefined {
  if (synth.axis === 'H' && Math.abs(synth.to.y - synth.from.y) < 1e-9) return 'H'
  if (synth.axis === 'V' && Math.abs(synth.to.x - synth.from.x) < 1e-9) return 'V'
  return undefined
}

/**
 * Replace `removeCount` segments at `at` with `insert`, then re-emit with every
 * later segment kept at its original absolute geometry. `decimals` is the
 * precision for anything rewritten.
 */
function rebuild(model: PathModel, at: number, removeCount: number, insert: readonly Synth[], decimals: number): string {
  const source = model.source.segments
  const spliced: PathData = {
    segments: [...source.slice(0, at), ...insert.map((s) => synthesise(s, decimals)), ...source.slice(at + removeCount)],
    trailing: model.source.trailing,
  }
  const next = createPathModel(spliced)
  const segments: AbsoluteSegment[] = [...next.segments]
  const firstLater = at + insert.length
  let subpathStart = firstLater > 0 ? subpathStartBefore(segments, firstLater) : { x: 0, y: 0 }
  for (let j = at + removeCount; j < model.segments.length; j += 1) {
    const k = j - removeCount + insert.length
    const original = model.segments[j]!
    const from = k > 0 ? segments[k - 1]!.to : { x: 0, y: 0 }
    let restored: AbsoluteSegment = { ...original, from }
    if (original.kind === 'move') subpathStart = original.to
    if (original.kind === 'close') restored = { ...restored, to: subpathStart }
    segments[k] = restored
  }
  return serializePathModel({ source: spliced, segments }, { decimals }).d
}

/** The start of the subpath segment `index` belongs to. */
function subpathStartBefore(segments: readonly AbsoluteSegment[], index: number): Point {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (segments[i]!.kind === 'move') return segments[i]!.to
  }
  return { x: 0, y: 0 }
}

/**
 * Add an anchor ON segment `index` at parameter `t` (0 < t < 1) by an exact
 * split — the shape does not change. Returns the new `d`, or `null` for a
 * segment that cannot be split (a move, an arc).
 */
export function insertAnchor(model: PathModel, index: number, t: number, decimals: number): string | null {
  const seg = model.segments[index]
  const src = model.source.segments[index]
  if (!seg || !src || t <= 0 || t >= 1) return null
  const relative = isRelative(src.command)
  if (seg.kind === 'line' || seg.kind === 'close') {
    const p = round(lerpPoint(seg.from, seg.to, t), decimals)
    const upper = src.command.toUpperCase()
    const axis = upper === 'H' || upper === 'V' ? upper : undefined
    const first: Synth = { kind: 'line', from: seg.from, to: p, relative, ...(axis ? { axis } : {}) }
    // A close keeps closing: a line to the new point, then the original `Z`.
    if (seg.kind === 'close') return rebuild(model, index, 0, [first], decimals)
    return rebuild(model, index, 1, [first, { kind: 'line', from: p, to: seg.to, relative, ...(axis ? { axis } : {}) }], decimals)
  }
  if (seg.kind === 'cubic') {
    const [a, b] = splitCubic([seg.from, seg.c1!, seg.c2!, seg.to], t)
    const p = round(a[3], decimals)
    return rebuild(model, index, 1, [
      { kind: 'cubic', from: seg.from, c1: round(a[1], decimals), c2: round(a[2], decimals), to: p, relative },
      { kind: 'cubic', from: p, c1: round(b[1], decimals), c2: round(b[2], decimals), to: seg.to, relative },
    ], decimals)
  }
  if (seg.kind === 'quad') {
    const [a, b] = splitQuad([seg.from, seg.c1!, seg.to], t)
    const p = round(a[2], decimals)
    return rebuild(model, index, 1, [
      { kind: 'quad', from: seg.from, c1: round(a[1], decimals), to: p, relative },
      { kind: 'quad', from: p, c1: round(b[1], decimals), to: seg.to, relative },
    ], decimals)
  }
  return null
}

/** A segment's handles as a cubic's, for a merge: a line has none (they sit on its ends), a quad is elevated. */
function asCubicHandles(seg: AbsoluteSegment): { c1: Point; c2: Point } | null {
  if (seg.kind === 'cubic') return { c1: seg.c1!, c2: seg.c2! }
  if (seg.kind === 'quad') {
    const [, c1, c2] = quadToCubic([seg.from, seg.c1!, seg.to])
    return { c1, c2 }
  }
  if (seg.kind === 'line') return { c1: seg.from, c2: seg.to }
  return null
}

/**
 * Remove the anchor that ends segment `index`, joining its two neighbouring
 * segments into one (Figma's delete-point: the curve keeps the outer
 * handles). Returns the new `d`, or `null` when the path would lose a whole
 * subpath or an arc is involved.
 */
export function removeAnchor(model: PathModel, index: number, decimals: number): string | null {
  const seg = model.segments[index]
  if (!seg || seg.kind === 'close' || seg.kind === 'arc') return null
  const next = model.segments[index + 1]
  const nextSrc = model.source.segments[index + 1]

  if (seg.kind === 'move') {
    // The first anchor of a subpath: the next point becomes the start.
    if (!next || !nextSrc || next.kind === 'move' || next.kind === 'close' || next.kind === 'arc') return null
    const after = model.segments[index + 2]
    if (!after || after.kind === 'move' || after.kind === 'close') return null // a subpath needs two points
    const srcCommand = model.source.segments[index]!.command
    return rebuild(model, index, 2, [{ kind: 'move', from: seg.from, to: next.to, relative: isRelative(srcCommand) }], decimals)
  }

  // The last anchor of an open subpath: drop its segment.
  if (!next || !nextSrc || next.kind === 'move') {
    const prev = model.segments[index - 1]
    if (!prev || prev.kind === 'move') return null // a subpath needs two points
    return rebuild(model, index, 1, [], decimals)
  }
  // Before a close: the close now runs from the previous point.
  if (next.kind === 'close') {
    const prev = model.segments[index - 1]
    if (!prev || prev.kind === 'move') return null
    return rebuild(model, index, 1, [], decimals)
  }
  if (next.kind === 'arc') return null

  const relative = isRelative(nextSrc.command)
  if (seg.kind === 'line' && next.kind === 'line') {
    // Two `h`s joined stay an `h` (two `v`s a `v`) when the result is still axis-aligned.
    const upper = nextSrc.command.toUpperCase()
    const axis = upper === 'H' || upper === 'V' ? upper : undefined
    return rebuild(model, index, 2, [{ kind: 'line', from: seg.from, to: next.to, relative, ...(axis ? { axis } : {}) }], decimals)
  }
  const inHandles = asCubicHandles(seg)
  const outHandles = asCubicHandles(next)
  if (!inHandles || !outHandles) return null
  return rebuild(model, index, 2, [
    { kind: 'cubic', from: seg.from, c1: round(inHandles.c1, decimals), c2: round(outHandles.c2, decimals), to: next.to, relative },
  ], decimals)
}

/** Whether the anchor ending segment `index` has a handle that is not sitting on it. */
export function anchorIsSmooth(model: PathModel, index: number): boolean {
  const seg = model.segments[index]
  const next = model.segments[index + 1]
  if (!seg) return false
  const incoming = seg.kind === 'cubic' ? seg.c2 : seg.kind === 'quad' ? seg.c1 : undefined
  const outgoing = next && (next.kind === 'cubic' || next.kind === 'quad') ? next.c1 : undefined
  return (incoming !== undefined && distance(incoming, seg.to) > 1e-9) || (outgoing !== undefined && distance(outgoing, seg.to) > 1e-9)
}

/**
 * Toggle the anchor ending segment `index` between CORNER (its handles pulled
 * onto it) and SMOOTH (collinear handles along the neighbours' chord, a third
 * of each neighbour's length — Penpot's make-curve). Returns the new `d`, or
 * `null` for an anchor that cannot be toggled (a move, a close, next to an arc).
 */
export function toggleAnchorSmooth(model: PathModel, index: number, decimals: number): string | null {
  const seg = model.segments[index]
  const next = model.segments[index + 1]
  const src = model.source.segments[index]
  const nextSrc = model.source.segments[index + 1]
  if (!seg || !src || seg.kind === 'move' || seg.kind === 'close' || seg.kind === 'arc') return null
  const hasNext = !!next && !!nextSrc && next.kind !== 'move' && next.kind !== 'close'
  if (hasNext && next!.kind === 'arc') return null

  if (anchorIsSmooth(model, index)) {
    // Corner: pull both handles onto the anchor (cubics keep their other handle).
    const inHandles = asCubicHandles(seg)!
    const insert: Synth[] = [{ kind: 'cubic', from: seg.from, c1: round(inHandles.c1, decimals), c2: seg.to, to: seg.to, relative: isRelative(src.command) }]
    if (hasNext) {
      const out = asCubicHandles(next!)!
      insert.push({ kind: 'cubic', from: seg.to, c1: seg.to, c2: round(out.c2, decimals), to: next!.to, relative: isRelative(nextSrc!.command) })
    }
    return rebuild(model, index, insert.length, insert, decimals)
  }

  // Smooth: handles along the chord from the previous point to the next one.
  const anchor = seg.to
  const after = hasNext ? next!.to : anchor
  const dir = { x: after.x - seg.from.x, y: after.y - seg.from.y }
  const length = Math.hypot(dir.x, dir.y)
  if (length < 1e-9) return null
  const unit = { x: dir.x / length, y: dir.y / length }
  const inLength = distance(seg.from, anchor) / 3
  const inHandles = asCubicHandles(seg)!
  const insert: Synth[] = [{
    kind: 'cubic',
    from: seg.from,
    c1: round(inHandles.c1, decimals),
    c2: round({ x: anchor.x - unit.x * inLength, y: anchor.y - unit.y * inLength }, decimals),
    to: anchor,
    relative: isRelative(src.command),
  }]
  if (hasNext) {
    const outLength = distance(anchor, next!.to) / 3
    const out = asCubicHandles(next!)!
    insert.push({
      kind: 'cubic',
      from: anchor,
      c1: round({ x: anchor.x + unit.x * outLength, y: anchor.y + unit.y * outLength }, decimals),
      c2: round(out.c2, decimals),
      to: next!.to,
      relative: isRelative(nextSrc!.command),
    })
  }
  return rebuild(model, index, insert.length, insert, decimals)
}
