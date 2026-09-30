/**
 * vectorPaintModel — what the Vector section reads out of a literal inline
 * `<svg>` and what it writes back (P5-D follow-up: "in svg I can't control the
 * fill and other stuff").
 *
 * A literal `<svg>` is ONE page-tree node (`base.svg`) whose `props.svg` is the
 * markup the parser serialised from the JSX, with every inner element stamped
 * with the `line:col` its `svg-attr` write lands on and the names of the
 * attributes that came from code (`inlineSvg.ts`, `@core/vector`'s
 * `svgPartStamps.ts`). The root `<svg>` carries only the code stamp: its
 * location is the node id itself. So the paint of a graphic is readable and
 * writable without its parts ever becoming nodes, and without a second parse:
 * this module reads the stamped markup, and the section posts `svg-attr` edits
 * through `svgPartCommits.ts` — one save and one undo entry per gesture.
 *
 * ## Targets
 *
 * `'all'` is the whole graphic, which is what a designer means by "the icon's
 * fill". It writes the attribute on the ROOT and removes the same literal
 * attribute from every shape that set its own, so the shapes inherit the
 * root's value — the change is visible and the source stays as small as it
 * was. (Writing the value onto every shape instead would leave N copies to
 * keep in sync.) `opacity` is the exception: it does not inherit, it
 * multiplies, so the whole graphic's opacity is the root's alone.
 *
 * A part id (`"7:10"`) targets one shape; its display falls back to what it
 * INHERITS when it sets nothing itself.
 *
 * ## What refuses
 *
 * Nothing is written over code. An attribute a target (or, for `'all'`, any
 * shape that would have to change) takes from an expression — `fill={color}`,
 * or a spread, which could override anything — makes that control read-only
 * with the reason; the server's `setSvgPartAttributes` refuses the same write
 * (`svg-attr-expression`) if anything reached it anyway.
 *
 * Pure apart from `DOMParser`, which the browser and happy-dom both have.
 */
import {
  SVG_CODE_ATTRIBUTE,
  SVG_PART_ATTRIBUTE,
  SVG_SPREAD_CODE,
  SVG_WRITABLE_PART_TAGS,
  parseSvgCodeAttributes,
} from '@core/vector'
import { hasWritableSourceLocation, type PageNode } from '@core/page-tree'
import type { SvgPartWrite } from '@site/studio/svgPartCommits'
import type { SelectionModel } from '../selectionModel'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** The paint attributes the section edits, by their JSX name. */
export type VectorPaintAttribute = 'fill' | 'stroke' | 'strokeWidth' | 'strokeLinecap' | 'strokeLinejoin' | 'opacity'

/** Root-only sizing attributes. */
export type VectorSizeAttribute = 'width' | 'height' | 'viewBox'

type VectorAttribute = VectorPaintAttribute | VectorSizeAttribute

const MARKUP_NAME: Readonly<Record<VectorAttribute, string>> = {
  fill: 'fill',
  stroke: 'stroke',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  opacity: 'opacity',
  width: 'width',
  height: 'height',
  viewBox: 'viewBox',
}

/** What SVG renders when nothing on the chain sets the attribute. */
const INITIAL_VALUE: Readonly<Record<VectorPaintAttribute, string>> = {
  fill: 'black',
  stroke: 'none',
  strokeWidth: '1',
  strokeLinecap: 'butt',
  strokeLinejoin: 'miter',
  opacity: '1',
}

/** Paint that inherits down the tree (every one but `opacity`, which composes). */
const INHERITED: ReadonlySet<VectorPaintAttribute> = new Set(['fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin'])

/** Elements that draw — where a fill or stroke is actually visible. */
const SHAPE_TAGS: ReadonlySet<string> = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'use'])

export interface VectorPart {
  /** The stamped `line:col`, or `''` for the root `<svg>`. */
  part: string
  tag: string
  /** Index of the nearest ancestor in the parts list (`null` for the root). */
  parent: number | null
  /** Markup attribute name → value, as serialised. */
  attributes: ReadonlyMap<string, string>
  /** JSX names that came from code; `*` when a spread may override anything. */
  code: ReadonlySet<string>
  isShape: boolean
}

export interface VectorGraphic {
  parts: readonly VectorPart[]
}

/**
 * The stamped graphic, or `null` when `markup` is not one `<svg>` document.
 * Inner elements without a part stamp (never written as JSX) and elements the
 * `svg-attr` edit does not write are skipped as targets, but their children
 * still inherit through them.
 */
export function readVectorGraphic(markup: string): VectorGraphic | null {
  if (typeof DOMParser === 'undefined' || markup.trim() === '') return null
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, 'text/html')
  const elements = Array.from(doc.body.children)
  const root = elements[0]
  if (elements.length !== 1 || !root || root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) return null

  const parts: VectorPart[] = []
  const visit = (element: Element, parent: number | null) => {
    const isRoot = parent === null
    const stamp = element.getAttribute(SVG_PART_ATTRIBUTE)
    let index = parent
    if (isRoot || (stamp && SVG_WRITABLE_PART_TAGS.has(element.localName))) {
      const attributes = new Map<string, string>()
      for (const attribute of Array.from(element.attributes)) attributes.set(attribute.name, attribute.value)
      parts.push({
        part: isRoot ? '' : stamp!,
        tag: element.localName,
        parent,
        attributes,
        code: parseSvgCodeAttributes(element.getAttribute(SVG_CODE_ATTRIBUTE)),
        isShape: SHAPE_TAGS.has(element.localName),
      })
      index = parts.length - 1
    }
    for (const child of Array.from(element.children)) visit(child, index)
  }
  visit(root, null)
  return { parts }
}

/** The value `name` has in `part`'s own markup (the root's `viewBox` keeps its case), or `undefined`. */
function ownValue(part: VectorPart, name: VectorAttribute): string | undefined {
  const markupName = MARKUP_NAME[name]
  return part.attributes.get(markupName) ?? part.attributes.get(markupName.toLowerCase())
}

/** What `name` resolves to on `parts[index]`: its own value, the nearest ancestor's, or SVG's initial value. */
function effectiveValue(parts: readonly VectorPart[], index: number, name: VectorPaintAttribute): string {
  for (let i: number | null = index; i !== null; i = INHERITED.has(name) ? parts[i]!.parent : null) {
    const own = ownValue(parts[i]!, name)
    if (own !== undefined) return own
  }
  return INITIAL_VALUE[name]
}

function isCodeBound(part: VectorPart, name: VectorAttribute): boolean {
  return part.code.has(SVG_SPREAD_CODE) || part.code.has(name)
}

/** `'all'`, or one part's stamped `line:col` (`''` = the root alone). */
export type VectorTarget = 'all' | string

export interface VectorFieldState {
  /** The value to show, or `null` when the shapes disagree (Mixed). */
  value: string | null
  /** True when the target does not set the value itself — it is inherited or SVG's default. */
  inherited: boolean
  /** Why this control cannot write, or `null` when it can. */
  lockedReason: string | null
}

function partIndex(graphic: VectorGraphic, target: VectorTarget): number {
  if (target === 'all') return 0
  return graphic.parts.findIndex((part) => part.part === target)
}

/** Shapes a whole-graphic paint write reaches: every shape, and the root when there is none. */
function wholeGraphicShapes(graphic: VectorGraphic): number[] {
  const shapes = graphic.parts.flatMap((part, index) => (part.isShape ? [index] : []))
  return shapes.length > 0 ? shapes : [0]
}

function describePart(part: VectorPart): string {
  return part.part === '' ? 'the <svg>' : `this <${part.tag}>`
}

function codeLockReason(part: VectorPart, name: VectorAttribute): string {
  return part.code.has(SVG_SPREAD_CODE)
    ? `${describePart(part)} takes its attributes from a spread ({...props}), which could override anything written here. Change it in the code.`
    : `${name} on ${describePart(part)} is set from code, so writing a value would delete that binding. Change it in the code.`
}

export function readVectorField(graphic: VectorGraphic, target: VectorTarget, name: VectorAttribute): VectorFieldState {
  const index = partIndex(graphic, target)
  const part = graphic.parts[index]
  if (!part) return { value: null, inherited: false, lockedReason: 'That part of the graphic is gone.' }

  if (name === 'width' || name === 'height' || name === 'viewBox') {
    const root = graphic.parts[0]!
    const own = ownValue(root, name)
    return { value: own ?? '', inherited: own === undefined, lockedReason: isCodeBound(root, name) ? codeLockReason(root, name) : null }
  }

  if (target !== 'all' || name === 'opacity') {
    const own = ownValue(part, name)
    return {
      value: effectiveValue(graphic.parts, index, name),
      inherited: own === undefined,
      lockedReason: isCodeBound(part, name) ? codeLockReason(part, name) : null,
    }
  }

  // The whole graphic: what the shapes actually draw with.
  const shapes = wholeGraphicShapes(graphic)
  const values = new Set(shapes.map((shape) => effectiveValue(graphic.parts, shape, name)))
  // Any part may be written (the root set, every literal cleared), and a
  // code-bound one would hide the root's value or refuse the clear.
  const blocker = graphic.parts.find((p) => isCodeBound(p, name))
  const rootOwn = ownValue(graphic.parts[0]!, name)
  return {
    value: values.size === 1 ? [...values][0]! : null,
    inherited: rootOwn === undefined && shapes.every((shape) => ownValue(graphic.parts[shape]!, name) === undefined),
    lockedReason: blocker ? codeLockReason(blocker, name) : null,
  }
}

/** A value as it is written into source: a number literal when it is one (`strokeWidth={2}`), else a string. */
function literal(name: VectorAttribute, value: string): string | number {
  if (name === 'width' || name === 'height' || name === 'strokeWidth' || name === 'opacity') {
    const trimmed = value.trim()
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  }
  return value
}

/** What a written literal was before, for the undo: the markup value, number-shaped when the write is. */
function previousLiteral(name: VectorAttribute, part: VectorPart): string | number | undefined {
  const own = ownValue(part, name)
  return own === undefined ? undefined : literal(name, own)
}

/**
 * The `svg-attr` writes that set `name` to `value` on `target` (`null`
 * removes it, back to inheriting), or a refusal sentence. One gesture's
 * writes — `commitSvgPartAttributes` posts them as one save and one undo.
 */
export function planVectorWrite(
  graphic: VectorGraphic,
  hostNodeId: string,
  target: VectorTarget,
  name: VectorAttribute,
  value: string | null,
): { ok: true; writes: SvgPartWrite[] } | { ok: false; reason: string } {
  const field = readVectorField(graphic, target, name)
  if (field.lockedReason) return { ok: false, reason: field.lockedReason }

  const writeOn = (part: VectorPart, next: string | null): SvgPartWrite | null => {
    const previous = previousLiteral(name, part)
    if (next === null) {
      if (previous === undefined) return null
      return { hostNodeId, part: part.part, partTag: part.tag, set: {}, remove: [name], previous: { [name]: previous } }
    }
    // Emitted even when it equals `previous`: inside a coalesced burst it is
    // what takes an earlier step back (`vectorPaintCommit.ts` drops the
    // burst's net no-ops before posting).
    const written = literal(name, next)
    return { hostNodeId, part: part.part, partTag: part.tag, set: { [name]: written }, previous: { [name]: previous } }
  }

  const sizing = name === 'width' || name === 'height' || name === 'viewBox'
  const writes: SvgPartWrite[] = []
  if (target === 'all' || sizing) {
    const root = graphic.parts[0]!
    const rootWrite = writeOn(root, value)
    if (rootWrite) writes.push(rootWrite)
    // Paint inherits: shapes that set their own value would hide the root's.
    if (!sizing && name !== 'opacity') {
      for (const part of graphic.parts.slice(1)) {
        const cleared = writeOn(part, null)
        if (cleared) writes.push(cleared)
      }
    }
  } else {
    const part = graphic.parts[partIndex(graphic, target)]
    if (!part) return { ok: false, reason: 'That part of the graphic is gone.' }
    const write = writeOn(part, value)
    if (write) writes.push(write)
  }
  return { ok: true, writes }
}

/** A short name per part for the target picker: `<path> 1`, `<circle> 2`. */
export function vectorTargetOptions(graphic: VectorGraphic): { label: string; value: VectorTarget }[] {
  const counts = new Map<string, number>()
  const options: { label: string; value: VectorTarget }[] = [{ label: 'Whole graphic', value: 'all' }]
  for (const part of graphic.parts.slice(1)) {
    const n = (counts.get(part.tag) ?? 0) + 1
    counts.set(part.tag, n)
    options.push({ label: `${part.tag} ${n}`, value: part.part })
  }
  return options
}

/** The `viewBox`'s width / height, or `null` when it has none that parses. */
export function viewBoxAspect(viewBox: string | null): number | null {
  const numbers = viewBox?.trim().split(/[\s,]+/).map(Number)
  if (!numbers || numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n))) return null
  const [, , width, height] = numbers as [number, number, number, number]
  return width > 0 && height > 0 ? width / height : null
}

/** The Vector section's manifest predicate: one selected node, and it is an inline `<svg>`. */
export function showsVectorSection(model: SelectionModel): boolean {
  return !model.isMultiSelect && model.selectedNode?.moduleId === 'base.svg'
}

/**
 * Why this graphic's paint cannot be written at all, or `null`. The same
 * facts `vectorEditVerdict` refuses point editing on, said for paint.
 */
export function vectorPaintRefusal(nodeId: string, node: PageNode, graphic: VectorGraphic | null): string | null {
  const markup = node.props.svg
  if (typeof markup !== 'string' || markup.length === 0) {
    return 'This graphic is built in code, so its fill and stroke are set there.'
  }
  if (typeof node.props.tag === 'string' && node.props.tag.length > 0) {
    return 'This icon’s markup comes from an .svg file (dangerouslySetInnerHTML), not from JSX elements in your code, so there is no attribute here to write. Edit the .svg file, or paste its markup into the page as an inline <svg>.'
  }
  if (!hasWritableSourceLocation(nodeId)) {
    return 'This graphic is drawn once per row of a list, so there is no single place in your code to write its paint.'
  }
  if (node.locked) return node.lockReason ? `This graphic is locked: ${node.lockReason}` : 'This graphic is locked.'
  if (!graphic) return 'This graphic is not one <svg> document, so Studio cannot read its paint.'
  return null
}
