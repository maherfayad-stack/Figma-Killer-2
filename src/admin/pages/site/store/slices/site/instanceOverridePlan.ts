/**
 * instanceOverridePlan — OD-19: "editing a value inside a shared component
 * changes ONLY that instance". The pure half: given an edit to a node that
 * sits inside a component instance, decide which of three things it is.
 *
 *   - `direct` — not this module's business: the node is not inside an
 *     instance, or the value it edits already belongs to one (a literal the
 *     CALL SITE passed, `textOrigin` / `resolvedProps[k].origin`), or it is
 *     code (the ordinary write refuses it by name). The store carries on as it
 *     always did.
 *   - `override` — every changed value is a LITERAL written in the
 *     component's own markup and the instance is exactly one call site deep:
 *     `exposeLiteralAsProp` turns each into an optional prop whose default is
 *     that literal and this call site passes the new value. Nobody else's
 *     rendering changes.
 *   - `whole-component` — the edit would land in the component (because the
 *     ordinary write is the only one that exists for it) and the codemod
 *     cannot prove the other instances stay identical: a value the markup
 *     does not state, an element inside a component inside this one, a list
 *     row. Today's behaviour is kept and `reason` is the one sentence that
 *     says why.
 *
 * Reads only the page tree and the load-time baseline; touches nothing. The
 * server stays the authority — it refuses what the codemod cannot prove
 * (`call-site-spread`, `maps-over-props`, an undestructured `props`, a props
 * type it cannot extend), and the caller then falls back to the ordinary write
 * with the server's sentence.
 *
 * A value that is ALREADY a prop (`<h2>{heading}</h2>`, which is what the
 * first override leaves every other instance with, and what a hand-written
 * component often is) is an `override` too, marked `fed`: the parser recorded
 * which prop feeds it (`PageNode.propFeeds`), and the write is the call site's
 * attribute alone (`exposeFedProp.ts`) — added when the instance does not pass
 * it, replaced when it passes a literal, never over an expression. That keeps
 * every instance editable per instance after the first override, including a
 * style (`style:<property>`), which the ordinary lock never lifts.
 */
import {
  hasWritableSourceLocation,
  inlineDepth,
  inlineSegments,
  isInlinedNodeId,
  MAX_INSTANCE_OVERRIDE_DEPTH,
  isPropWritableToSource,
  styleValueKey,
  type PageNode,
} from '@core/page-tree'
import type { LoadedNodeValues } from '@site/studio/loadedValuesBaseline'

export type OverrideTarget = { kind: 'text' } | { kind: 'attribute'; name: string } | { kind: 'style'; property: string }

/** One value of the element the instance gives its own, and the prop it travels through. */
export interface PlannedOverride {
  /** The key the autosave diff and the baseline know this value by: a prop name, or `style:<property>`. */
  key: string
  target: OverrideTarget
  /** The preferred prop name — the server picks a free variant when it is taken. */
  propName: string
  value: string | number | boolean
  /** The value is already the bare read of the prop `propName`: only the call site changes, nothing is exposed. */
  fed?: true
}

/** What a store action was asked to change on one node. */
export interface OverrideChange {
  props?: Record<string, unknown>
  styles?: Record<string, string | number | null | undefined>
}

export type OverridePlan =
  | { kind: 'direct' }
  | { kind: 'whole-component'; reason: string }
  | { kind: 'override'; overrides: PlannedOverride[] }

export interface OverridePlanInput {
  node: PageNode
  nodeId: string
  change: OverrideChange
  /** The module's inline-text prop (`registry.get(moduleId)?.inlineTextEdit?.prop`) — the one prop that is the element's TEXT. */
  textProp: string | undefined
  /** The values the board read from disk for this node (`getLoadedNodeValues`): what the file stated as a literal. */
  baseline: LoadedNodeValues | undefined
  /** The instance node (the call site) this node sits in, when the board has it: its `callSiteProps` say whether a fed prop may be written there. */
  callSite: PageNode | undefined
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
/** Props that are not attributes of the element — renaming the element is not a per-instance value. */
const ELEMENT_SHAPE_PROPS = new Set(['tag', 'customTag'])
/** Attribute names that read badly as a prop of the same name (and would collide with the attribute itself). */
const ATTRIBUTE_PROP_NAMES: Record<string, string> = {
  alt: 'altText',
  title: 'titleText',
  href: 'url',
  placeholder: 'placeholderText',
}

function camelCase(name: string): string {
  return name.replace(/[-:_]+([A-Za-z0-9])/g, (_, next: string) => next.toUpperCase())
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function textPropName(node: PageNode): string {
  const tag = (node.props as { tag?: unknown }).tag
  if (typeof tag !== 'string') return 'text'
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'p') return 'body'
  return tag === 'button' || tag === 'a' || tag === 'span' || tag === 'label' ? 'label' : 'text'
}

function attributePropName(attribute: string): string {
  const named = ATTRIBUTE_PROP_NAMES[attribute] ?? `${camelCase(attribute)}Value`
  return IDENTIFIER_RE.test(named) ? named : 'value'
}

function stylePropName(property: string): string {
  const named = `${camelCase(property)}Value`
  return IDENTIFIER_RE.test(named) ? named : 'styleValue'
}

/** The sentence for "this edit goes to the component, and every instance changes". */
function everywhere(componentName: string, why: string): string {
  return `${why}, so this changes every ${componentName}.`
}

export function planInstanceOverride(input: OverridePlanInput): OverridePlan {
  const { node, nodeId, change, textProp, baseline, callSite } = input
  /** A fed value may be written at the call site unless it passes that prop as code (an expression with no literal behind it). */
  const callSiteTakesProp = (prop: string): boolean => callSite !== undefined && isPropWritableToSource(callSite, `callSiteProps:${prop}`)
  if (!isInlinedNodeId(nodeId)) return { kind: 'direct' }
  const name = node.fromComponent ?? 'component'

  const overrides: PlannedOverride[] = []
  const unsupported: string[] = []
  let direct = 0

  for (const [key, value] of Object.entries(change.props ?? {})) {
    if (Object.is((node.props as Record<string, unknown>)[key], value)) continue
    if (!isScalar(value)) {
      direct += 1
      continue
    }
    if (ELEMENT_SHAPE_PROPS.has(key)) {
      unsupported.push(everywhere(name, `${name} writes its element's tag once`))
      continue
    }
    const isText = key === textProp
    const owned = isText ? node.textOrigin !== undefined : node.resolvedProps?.[key]?.origin !== undefined
    const feed = owned ? undefined : node.propFeeds?.[key]
    if (feed !== undefined) {
      // The component passes this on from its own prop: the call site is the target.
      if (!callSiteTakesProp(feed)) return { kind: 'direct' }
      overrides.push({ key, target: isText ? { kind: 'text' } : { kind: 'attribute', name: key }, propName: feed, value, fed: true })
      continue
    }
    // Code with no literal behind it: the ordinary write refuses the whole patch by name.
    if (!isPropWritableToSource(node, key)) return { kind: 'direct' }
    // The call site (or a dictionary) already owns this value: the ordinary write is instance-local.
    if (owned) {
      direct += 1
      continue
    }
    if (baseline?.[key] === undefined) {
      unsupported.push(everywhere(name, isText ? `${name} has no text of its own there to override` : `${name} does not set \`${key}\` on that element`))
      continue
    }
    overrides.push(
      isText
        ? { key, target: { kind: 'text' }, propName: textPropName(node), value }
        : { key, target: { kind: 'attribute', name: key }, propName: attributePropName(key), value },
    )
  }

  for (const [property, value] of Object.entries(change.styles ?? {})) {
    const key = styleValueKey(property)
    const removal = value === null || value === undefined || value === ''
    if (!removal && Object.is(node.inlineStyles?.[property], value)) continue
    const feed = node.propFeeds?.[key]
    if (feed !== undefined) {
      // A fed style cannot be cleared for one instance (a prop has no "absent" a literal can say), and is only written as a plain scalar.
      if (removal || !callSiteTakesProp(feed)) return { kind: 'direct' }
      if (!isScalar(value) || typeof value === 'boolean') {
        direct += 1
        continue
      }
      overrides.push({ key, target: { kind: 'style', property }, propName: feed, value, fed: true })
      continue
    }
    if ((node.codeProps ?? []).includes(key)) return { kind: 'direct' }
    if (removal) {
      if (baseline?.[key] !== undefined) unsupported.push(everywhere(name, `${name} sets \`${property}\` itself, and removing it can't be limited to one instance`))
      continue
    }
    if (!isScalar(value) || typeof value === 'boolean') {
      direct += 1
      continue
    }
    if (baseline?.[key] === undefined || !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(property)) {
      unsupported.push(everywhere(name, `${name} does not set \`${property}\` on that element`))
      continue
    }
    overrides.push({ key, target: { kind: 'style', property }, propName: stylePropName(property), value })
  }

  if (unsupported.length > 0) return { kind: 'whole-component', reason: unsupported[0]! }
  if (overrides.length === 0) return { kind: 'direct' }
  if (direct > 0) return { kind: 'whole-component', reason: everywhere(name, `Part of this edit is a value ${name} does not state in its own markup`) }
  if (inlineDepth(nodeId) > MAX_INSTANCE_OVERRIDE_DEPTH) {
    return { kind: 'whole-component', reason: everywhere(name, `This sits ${inlineDepth(nodeId)} components deep, and a value is only passed down ${MAX_INSTANCE_OVERRIDE_DEPTH} levels`) }
  }
  // Every call site on the way down must be one placed piece of JSX; a list renders N of them from one.
  if (!inlineSegments(nodeId).slice(0, -1).every(hasWritableSourceLocation)) {
    return { kind: 'whole-component', reason: everywhere(name, `${name} is repeated by a list here, and one piece of code renders every item`) }
  }
  return { kind: 'override', overrides }
}

/** Why an edit the server's codemod would not prove per-instance is written to the component instead — one sentence. */
export function refusalSentence(reason: string, componentName: string): string | null {
  switch (reason) {
    case 'not-a-literal':
      return everywhere(componentName, `${componentName} does not state that value as a plain literal`)
    case 'maps-over-props':
      return everywhere(componentName, `${componentName} renders that once per item of a list it is handed`)
    case 'call-site-spread':
      return everywhere(componentName, `Some ${componentName} spreads an object of props, which might already carry the new prop's name`)
    case 'unsupported-params':
      return everywhere(componentName, `${componentName} reads its props as one object`)
    case 'unsupported-props-type':
      return everywhere(componentName, `${componentName}'s props are typed in a way Studio can't extend`)
    case 'unresolvable':
    case 'package-component':
    case 'not-in-component':
    case 'no-source-location':
      return everywhere(componentName, `Studio can't trace this ${componentName} to a component in your source`)
    default:
      return null
  }
}
