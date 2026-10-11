/**
 * pathModel — an editable, absolute-coordinate view over a parsed path, and
 * the minimal re-emit that turns an edit back into `d`.
 *
 * `pathData.ts` keeps the source text; this module keeps the GEOMETRY. Each
 * segment is resolved to absolute points (`from`, `to`, and its handles), with
 * `S`/`T` handle reflection and `m`-after-`z` current-point rules applied the
 * way a browser applies them. An edit changes the geometry; `serializePathModel`
 * then walks every segment and asks one question — would re-deriving this
 * segment's arguments from the new geometry, in its ORIGINAL command form,
 * give the arguments the source already has? If so, the source text is kept
 * byte-for-byte. Only the segments whose arguments actually changed are
 * rewritten, which for an anchor moved in a relative path is exactly two: the
 * segment ending at the anchor and the one starting there.
 *
 * A rewritten segment keeps its form wherever the form can still say it:
 *   - relative stays relative, absolute stays absolute;
 *   - `H`/`V` stays while the orthogonal coordinate is unchanged, else `L`;
 *   - `S`/`T` stays while its implicit handle is still the reflection, else
 *     `C`/`Q`;
 *   - an arc stays an arc (its radii and flags are kept; only its endpoint
 *     moved);
 *   - an implicit repeat stays implicit while the command before it still
 *     implies it, and gains its letter when it does not.
 */
import {
  impliedRepeatCommand,
  PATH_ARGUMENT_COUNT,
  type PathCommand,
  type PathData,
  type PathSegment,
} from './pathData'
import type { Point } from './pathGeometry'
import { formatPathNumber } from './precision'

export type SegmentKind = 'move' | 'line' | 'cubic' | 'quad' | 'arc' | 'close'

export interface AbsoluteSegment {
  readonly kind: SegmentKind
  readonly from: Point
  readonly to: Point
  /** Cubic: first handle. Quad: the single control point. */
  readonly c1?: Point
  /** Cubic: second handle. */
  readonly c2?: Point
  /** Arc: `[rx, ry, rotation, largeArc, sweep]` as written. */
  readonly arc?: readonly [number, number, number, number, number]
}

export interface PathModel {
  readonly source: PathData
  readonly segments: readonly AbsoluteSegment[]
}

const EPSILON = 1e-9

function samePoint(a: Point | undefined, b: Point | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON
}

function reflect(point: Point, about: Point): Point {
  return { x: 2 * about.x - point.x, y: 2 * about.y - point.y }
}

function isRelative(command: PathCommand): boolean {
  return command === command.toLowerCase()
}

/** Resolve every segment of `path` to absolute geometry. */
export function createPathModel(path: PathData): PathModel {
  const segments: AbsoluteSegment[] = []
  let current: Point = { x: 0, y: 0 }
  let subpathStart: Point = current
  let previous: AbsoluteSegment | undefined
  let previousUpper = ''

  for (const segment of path.segments) {
    const upper = segment.command.toUpperCase()
    const v = segment.values
    const base = isRelative(segment.command) ? current : { x: 0, y: 0 }
    const at = (i: number): Point => ({ x: base.x + v[i]!, y: base.y + v[i + 1]! })
    let next: AbsoluteSegment
    switch (upper) {
      case 'M':
        next = { kind: 'move', from: current, to: at(0) }
        subpathStart = next.to
        break
      case 'L':
        next = { kind: 'line', from: current, to: at(0) }
        break
      case 'H':
        next = { kind: 'line', from: current, to: { x: base.x + v[0]!, y: current.y } }
        break
      case 'V':
        next = { kind: 'line', from: current, to: { x: current.x, y: base.y + v[0]! } }
        break
      case 'C':
        next = { kind: 'cubic', from: current, c1: at(0), c2: at(2), to: at(4) }
        break
      case 'S': {
        const c1 = (previousUpper === 'C' || previousUpper === 'S') && previous?.c2 ? reflect(previous.c2, current) : current
        next = { kind: 'cubic', from: current, c1, c2: at(0), to: at(2) }
        break
      }
      case 'Q':
        next = { kind: 'quad', from: current, c1: at(0), to: at(2) }
        break
      case 'T': {
        const c1 = (previousUpper === 'Q' || previousUpper === 'T') && previous?.c1 ? reflect(previous.c1, current) : current
        next = { kind: 'quad', from: current, c1, to: at(0) }
        break
      }
      case 'A':
        next = { kind: 'arc', from: current, to: at(5), arc: [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!] }
        break
      default:
        next = { kind: 'close', from: current, to: subpathStart }
    }
    segments.push(next)
    current = next.to
    previous = next
    previousUpper = upper
  }
  return { source: path, segments }
}

/** Every anchor a user can drag: the index of each segment whose `to` is an on-curve point. */
export function anchorSegmentIndices(model: PathModel): number[] {
  return model.segments.flatMap((segment, index) => (segment.kind === 'close' ? [] : [index]))
}

function translate(point: Point | undefined, delta: Point): Point | undefined {
  return point === undefined ? undefined : { x: point.x + delta.x, y: point.y + delta.y }
}

/**
 * Move the anchor at the end of segment `index` by `delta`, carrying the
 * handles attached to it (the incoming handle of that segment and the
 * outgoing handle of the next), the way every vector editor moves a point.
 * Every later segment's `from` follows, and a `close` returning to a moved
 * subpath start follows too.
 */
export function moveAnchor(model: PathModel, index: number, delta: Point): PathModel {
  const target = model.segments[index]
  if (!target || target.kind === 'close') return model
  const segments = [...model.segments]
  segments[index] = { ...target, to: translate(target.to, delta)!, ...(target.kind === 'cubic' ? { c2: translate(target.c2, delta) } : {}) }
  const following = segments[index + 1]
  if (following && following.kind === 'cubic') segments[index + 1] = { ...following, c1: translate(following.c1, delta) }
  return { source: model.source, segments: rechain(segments) }
}

/** Move one handle (`c1` or `c2`) of segment `index` by `delta`. */
export function moveHandle(model: PathModel, index: number, handle: 'c1' | 'c2', delta: Point): PathModel {
  const target = model.segments[index]
  if (!target || target[handle] === undefined) return model
  const segments = [...model.segments]
  segments[index] = { ...target, [handle]: translate(target[handle], delta) }
  return { source: model.source, segments }
}

/**
 * Re-derive every `from` (and each `close`'s `to`) from the chain of `to`s
 * after an anchor moved. A `close` always returns to its subpath's start, so a
 * moved start carries its `close` with it.
 */
function rechain(segments: AbsoluteSegment[]): AbsoluteSegment[] {
  let current: Point = { x: 0, y: 0 }
  let subpathStart = current
  return segments.map((segment) => {
    let next: AbsoluteSegment = samePoint(segment.from, current) ? segment : { ...segment, from: current }
    if (segment.kind === 'move') subpathStart = next.to
    if (segment.kind === 'close' && !samePoint(next.to, subpathStart)) next = { ...next, to: subpathStart }
    current = next.to
    return next
  })
}

export interface SerializeOptions {
  /** Decimals for rewritten numbers; the source segment's own decimals are the floor. Default 3. */
  readonly decimals?: number
}

export interface SerializedPath {
  readonly d: string
  /** Indices of the segments whose text was rewritten. */
  readonly changed: readonly number[]
}

/** Arguments for `segment` rewritten in `command`'s form. */
function argumentsFor(command: PathCommand, segment: AbsoluteSegment): number[] {
  const base = isRelative(command) ? segment.from : { x: 0, y: 0 }
  const rel = (p: Point | undefined): number[] => [p!.x - base.x, p!.y - base.y]
  switch (command.toUpperCase()) {
    case 'M':
    case 'L':
    case 'T':
      return rel(segment.to)
    case 'H':
      return [segment.to.x - base.x]
    case 'V':
      return [segment.to.y - base.y]
    case 'C':
      return [...rel(segment.c1), ...rel(segment.c2), ...rel(segment.to)]
    case 'S':
      return [...rel(segment.c2), ...rel(segment.to)]
    case 'Q':
      return [...rel(segment.c1), ...rel(segment.to)]
    case 'A':
      return [...segment.arc!, ...rel(segment.to)]
    default:
      return []
  }
}

/** The command form `segment` can still be written in, starting from its source command. */
function commandFor(source: PathCommand, segment: AbsoluteSegment, previous: AbsoluteSegment | undefined, previousCommand: string): PathCommand {
  const upper = source.toUpperCase()
  const relative = isRelative(source)
  const withCase = (letter: string): PathCommand => (relative ? letter.toLowerCase() : letter) as PathCommand
  if (upper === 'H') return Math.abs(segment.to.y - segment.from.y) < EPSILON ? source : withCase('L')
  if (upper === 'V') return Math.abs(segment.to.x - segment.from.x) < EPSILON ? source : withCase('L')
  if (upper === 'S') {
    const reflects = (previousCommand === 'C' || previousCommand === 'S') && previous?.c2 ? reflect(previous.c2, segment.from) : segment.from
    return samePoint(reflects, segment.c1) ? source : withCase('C')
  }
  if (upper === 'T') {
    const reflects = (previousCommand === 'Q' || previousCommand === 'T') && previous?.c1 ? reflect(previous.c1, segment.from) : segment.from
    return samePoint(reflects, segment.c1) ? source : withCase('Q')
  }
  return source
}

function sameValues(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) < EPSILON)
}

function formatArguments(command: PathCommand, values: readonly number[], decimals: number, comma: boolean): string {
  const upper = command.toUpperCase()
  const numbers = values.map((value, i) => (upper === 'A' && (i === 3 || i === 4) ? String(value ? 1 : 0) : formatPathNumber(value, decimals)))
  if (!comma || numbers.length < 2) return numbers.join(' ')
  const pairs: string[] = []
  const pairable = upper === 'A' ? [numbers.slice(0, 2).join(','), numbers[2]!, numbers.slice(3, 5).join(','), numbers.slice(5).join(',')] : undefined
  if (pairable) return pairable.join(' ')
  for (let i = 0; i < numbers.length; i += 2) pairs.push(numbers.slice(i, i + 2).join(','))
  return pairs.join(' ')
}

/**
 * The model back to `d`, keeping every segment whose arguments did not change
 * byte-for-byte and rewriting only the rest (see the module doc).
 */
export function serializePathModel(model: PathModel, options: SerializeOptions = {}): SerializedPath {
  const comma = model.source.segments.some((segment) => segment.text.includes(','))
  const changed: number[] = []
  let out = ''
  let emittedCommand: PathCommand | undefined
  let previousUpper = ''

  model.segments.forEach((segment, index) => {
    const source: PathSegment = model.source.segments[index]!
    const command = commandFor(source.command, segment, model.segments[index - 1], previousUpper)
    const values = argumentsFor(command, segment)
    const implied = emittedCommand === undefined ? undefined : impliedRepeatCommand(emittedCommand)
    const canStayImplicit = source.implicit && implied === command

    if (command === source.command && sameValues(values, source.values) && (source.implicit ? canStayImplicit : true)) {
      out += source.text
    } else {
      changed.push(index)
      const decimals = Math.max(options.decimals ?? 3, source.decimals)
      const body = formatArguments(command, values, decimals, comma)
      if (canStayImplicit) {
        const lead = source.lead === '' ? ' ' : source.lead
        out += `${lead}${body}`
      } else {
        const lead = source.implicit ? ' ' : source.lead
        out += PATH_ARGUMENT_COUNT[command.toUpperCase()] === 0 ? `${lead}${command}` : `${lead}${command}${body}`
      }
    }
    emittedCommand = command
    previousUpper = command.toUpperCase()
  })
  return { d: out + model.source.trailing, changed }
}
