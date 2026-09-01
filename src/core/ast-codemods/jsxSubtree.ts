/**
 * jsxSubtree — the shape of a JSX subtree an edit writes, and the two things
 * every writer of one needs: rendering it to source text, and refusing it
 * before a byte is written.
 *
 * Split out of `insertJsxElement.ts` because it was never that codemod's alone.
 * `insertJsxIntoSlotProp.ts` writes the identical subtree into a component PROP
 * rather than a child list, and already imported `renderJsxNode`,
 * `collectSubtreeImports` and `validateSubtree` from it — three of the four
 * exports here — while the two modules share nothing else. What differs between
 * them is PLACEMENT, which each keeps.
 */
import { isSafeIntrinsicTagName, VOID_HTML_ELEMENTS } from '@core/utils/htmlTags'
import type { JsonDataValue } from '@core/utils/jsonData'
import type { JsxChildRangeReason } from './jsxChildRange'

/**
 * A prop written onto the new element.
 *
 * Scalars spell themselves. STRUCTURED values are here because a design system's
 * content often is one: `<TabBar items={[{ label: 'Home' }]}/>` — `items` is the
 * entire content of a tab bar, and the package's own docs are what supply the
 * value. Dropping it (which this used to do, for every array and object alike)
 * meant an inserted TabBar was written to source as `<TabBar platform="ios"
 * value={0}/>`, reloaded from that source, and drew an empty bar — the exact
 * report that "the tab bar renders with nothing in it", surviving two rounds of
 * fixes upstream because the value was being discarded on its way to disk.
 *
 * The old rule — "writing a guess into someone's repository is worse than
 * writing nothing" — still holds and is not what this is. A guess is a shape
 * Studio invented; this is a JSON value the caller already holds, with one
 * exact JSX spelling. What genuinely has no spelling (a function, a slot
 * sentinel) is not a `JsonDataValue` and still never arrives.
 *
 * A React ELEMENT is the exception, and it is why {@link JsxPropElement}
 * exists: `<TabBar items={[{ icon: <svg…/>, label: 'Home' }]}/>` is the
 * documented shape of a tab bar, and an icon that cannot be written is an
 * empty icon slot on every tab. It arrives as a VALIDATED ELEMENT TREE, never
 * as source text — the same `InsertJsxNode` `children` already carries, through
 * the same `validateSubtree` tag-safety gate — so nothing here can splice
 * arbitrary text into a user's file.
 */
export type InsertableJsxPropValue = JsonDataValue | JsxPropElement | InsertableJsxPropValue[] | { [key: string]: InsertableJsxPropValue }

/**
 * A React element in PROP position, tagged so it cannot be confused with the
 * plain object it would otherwise look like.
 *
 * The marker is a single reserved key rather than a heuristic ("does this
 * object look like an element?") because the values around it are the user's
 * own data: a tab item is `{ icon, label }`, and an object holding `name` and
 * `props` is a perfectly ordinary thing for a design system to take.
 */
export interface JsxPropElement {
  __jsx: JsxPropElementNode
}

/**
 * What may sit inside a prop: an INTRINSIC element tree with scalar props.
 *
 * Deliberately narrower than {@link InsertJsxNode} — no `importSpecifier`, and
 * no elements nested inside its own props. A prop element is a glyph, not a
 * scene: the case this exists for is `icon: <svg…/>`, which `svgToJsxNode`
 * already produces and already caps at 256 nodes and 12 levels. The absence of
 * `importSpecifier` is load-bearing rather than an omission — `validateSubtree`
 * refuses a capitalised tag with no import, so a prop element cannot smuggle in
 * a component, and the type stays self-recursive instead of mutually recursive
 * with the node that holds it (which TypeBox could not express as one schema).
 */
export interface JsxPropElementNode {
  name: string
  props?: Record<string, JsonDataValue | undefined>
  children?: string | JsxPropElementNode[]
}

/** Whether `value` is the tagged element form — see {@link JsxPropElement}. */
export function isJsxPropElement(value: unknown): value is JsxPropElement {
  return typeof value === 'object' && value !== null && '__jsx' in value
}

/**
 * One element in a subtree an insert writes. Identical in shape to the insert
 * itself minus the placement fields, and recursive through `children`.
 */
export interface InsertJsxNode {
  /** A component (`Button`) with an `importSpecifier`, an intrinsic tag (`div`) without one. */
  name: string
  props?: Record<string, InsertableJsxPropValue | undefined>
  importSpecifier?: string
  children?: InsertJsxChildren
}

/**
 * An element's content: literal text, or a list of nested elements.
 *
 * Text and elements are deliberately EXCLUSIVE rather than an interleaved
 * list. A leaf carries a label; a container carries elements. Mixed content
 * (`<p>Hello <b>you</b></p>`) is the one JSX shape whose text nodes have no
 * stable identity for the parser to hand back an editable node id for — the
 * same reason `setJsxText` refuses a mixed-content target
 * (`JsxTextTargetError`). Allowing it here would let an insert manufacture
 * source this pipeline cannot then edit.
 */
export type InsertJsxChildren = string | InsertJsxNode[]

export type InsertJsxRefusalReason =
  | JsxChildRangeReason
  | 'not-a-container'
  | 'not-siblings'
  | 'binding-conflict'
  | 'unsafe-tag'
  | 'void-element-children'

export interface InsertJsxRefusal {
  reason: InsertJsxRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

/** One refusal, in the shape both codemods return it. */
export function refuse(reason: InsertJsxRefusalReason, message: string): { ok: false; refusal: InsertJsxRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/** Prefix every line after the first with `indent`, aligning a rendered block under its placement. */
export function indentBlock(block: string, indent: string): string {
  return indent.length === 0 ? block : block.split('\n').join(`\n${indent}`)
}

/** A key that can be written bare in an object literal, rather than quoted. */
const PLAIN_OBJECT_KEY = /^[A-Za-z_$][\w$]*$/

/**
 * A {@link JsonDataValue} as the JS source text that goes inside `prop={…}`.
 *
 * `JSON.stringify` alone would be valid JSX and is not what a person writes:
 * it quotes every key, so a seeded tab bar would land in the user's repository
 * as `items={[{"label":"Home"}]}`. This is their source file — the first thing
 * they will read after inserting — so bare keys and spaced braces are worth the
 * dozen lines. Strings keep JSON's double quotes and, with them, JSON's
 * escaping, which is the part that must not be hand-rolled.
 */
function jsxExpressionLiteral(value: InsertableJsxPropValue, unit: string): string {
  if (isJsxPropElement(value)) return renderJsxNode(value.__jsx, unit)
  if (Array.isArray(value)) {
    const items = value.map((item) => jsxExpressionLiteral(item, unit))
    const inline = `[${items.join(', ')}]`
    if (!isTooLongToInline(inline)) return inline
    // One entry per line. A tab bar's five items each carry a full inline
    // `<svg>` of path data, and on one line that is a 12 KB attribute nobody
    // can read — in the user's own page file, which is the first thing they
    // open after inserting.
    return ['[', ...items.map((item) => `${unit}${indentBlock(item, unit)},`), ']'].join('\n')
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, item]) => `${PLAIN_OBJECT_KEY.test(key) ? key : JSON.stringify(key)}: ${jsxExpressionLiteral(item, unit)}`,
    )
    if (entries.length === 0) return '{}'
    const inline = `{ ${entries.join(', ')} }`
    if (!isTooLongToInline(inline)) return inline
    return ['{', ...entries.map((entry) => `${unit}${indentBlock(entry, unit)},`), '}'].join('\n')
  }
  return JSON.stringify(value)
}

/**
 * Whether a rendered value has to break across lines.
 *
 * Two triggers, and the first is the one that matters: text that ALREADY spans
 * lines (a nested `<svg>` element with children) cannot be glued into a
 * comma-separated run without producing the ragged half-indented shape that
 * made a five-tab `items` unreadable. The width cap catches the other case, a
 * long flat list. 72 leaves room for the `prop={…}` and the indentation it
 * sits under inside an 80-ish column.
 */
function isTooLongToInline(rendered: string): boolean {
  return rendered.includes('\n') || rendered.length > 72
}

export function renderJsxNode(node: InsertJsxNode, unit: string): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (value === undefined) continue
    if (typeof value === 'boolean') {
      // `<Button disabled />` for true; a false prop is simply not written,
      // which is what the absence of the attribute already means.
      if (value) parts.push(key)
      continue
    }
    if (typeof value === 'string') {
      parts.push(`${key}=${JSON.stringify(value)}`)
      continue
    }
    // Numbers, `null`, and every structured value are JSX EXPRESSIONS, not
    // string attributes: `value={40}`, `items={[{ label: "Home" }]}`.
    parts.push(`${key}={${jsxExpressionLiteral(value, unit)}}`)
  }
  const attrs = parts.length > 0 ? ` ${parts.join(' ')}` : ''
  const { name, children } = node

  if (children === undefined) return `<${name}${attrs} />`
  if (typeof children === 'string') return `<${name}${attrs}>${escapeJsxText(children)}</${name}>`
  // An empty array is an explicitly childless element — same output as no
  // `children` at all, rather than an empty paired tag nothing needs.
  if (children.length === 0) return `<${name}${attrs} />`

  const inner = children.map((child) => `${unit}${indentBlock(renderJsxNode(child, unit), unit)}`)
  return [`<${name}${attrs}>`, ...inner, `</${name}>`].join('\n')
}

/** Depth-first walk of a subtree, root included. */
function* walkSubtree(node: InsertJsxNode): Generator<InsertJsxNode> {
  yield node
  // An element in PROP position is as real as one in the child list — it needs
  // the same tag-safety refusal and contributes the same imports — and it is
  // reachable only through the prop values, which `children` never sees.
  for (const value of Object.values(node.props ?? {})) {
    if (value !== undefined) yield* walkPropElements(value)
  }
  const { children } = node
  if (children === undefined || typeof children === 'string') return
  for (const child of children) yield* walkSubtree(child)
}

/** Every {@link JsxPropElement} nested anywhere inside one prop value. */
function* walkPropElements(value: InsertableJsxPropValue): Generator<InsertJsxNode> {
  if (isJsxPropElement(value)) {
    yield* walkSubtree(value.__jsx)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* walkPropElements(item)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) yield* walkPropElements(item)
  }
}

/**
 * Every `(componentName, importSpecifier)` the subtree needs in scope,
 * deduplicated. Intrinsic tags contribute nothing.
 *
 * Exported for `insertJsxIntoSlotProp.ts` — a slot fill needs the identical
 * "what imports does this subtree require" answer.
 */
export function collectSubtreeImports(root: InsertJsxNode): Map<string, string> {
  const required = new Map<string, string>()
  for (const node of walkSubtree(root)) {
    if (node.importSpecifier !== undefined) required.set(node.name, node.importSpecifier)
  }
  return required
}

/**
 * The first refusal anywhere in the subtree, or `undefined` when all of it is
 * writable. Runs before any byte is written so a bad grandchild cannot leave a
 * half-built element behind.
 *
 * Exported for `insertJsxIntoSlotProp.ts` — the tag-name/void-element rules
 * are exactly the same for a subtree written into a prop as for one written
 * into a child list; only the PLACEMENT differs between the two codemods.
 */
export function validateSubtree(root: InsertJsxNode): { ok: false; refusal: InsertJsxRefusal } | undefined {
  for (const node of walkSubtree(root)) {
    const { name, importSpecifier, children } = node

    // An intrinsic tag is the no-import case, so its name gets no validation
    // from an import resolving or failing to resolve — it has to be checked
    // here or not at all. See this module's "COMPONENTS AND INTRINSIC TAGS".
    if (importSpecifier === undefined && !isSafeIntrinsicTagName(name)) {
      return refuse(
        'unsafe-tag',
        /^[A-Z]/.test(name)
          ? `"${name}" starts with a capital letter, so JSX reads it as a component, not an HTML tag — pass importSpecifier to say where it is imported from.`
          : `"${name}" is not a tag Studio will write: it must be a well-formed HTML element name and must not be one that executes script or loads external resources.`,
      )
    }

    const hasContent = children !== undefined && (typeof children === 'string' || children.length > 0)
    if (hasContent && VOID_HTML_ELEMENTS.has(name.toLowerCase())) {
      return refuse(
        'void-element-children',
        `<${name}> is a void element and cannot hold children, so there is nowhere to write this content.`,
      )
    }
  }
  return undefined
}

/**
 * Make `text` safe to sit between two JSX tags.
 *
 * Only four characters can leave JSX text mode, and each is escaped as the
 * HTML entity React renders back to the original character, so the element's
 * rendered text is exactly what the caller asked for:
 *   - `<` would open a tag, `>` is invalid in JSX text
 *   - `{` `}` would open an expression container
 * A newline is not escaped but IS rejected upstream of nothing — it would
 * merely reflow, which JSX collapses to a single space, so it is left alone.
 */
function escapeJsxText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}
