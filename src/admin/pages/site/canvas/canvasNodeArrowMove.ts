/**
 * canvasNodeArrowMove — what an arrow key does to the selected layer (P2-C,
 * IX-1). Penpot's `move-selected` rule, in CSS terms:
 *
 *   - a layer that is `position: absolute | fixed` NUDGES: its offsets move by
 *     1 px, or 10 with ⇧. The write is one inline style — the element's own
 *     `style={{…}}`, one honest target — so it is a VALUE edit;
 *   - any other layer is laid out by its parent, so moving it by a pixel would
 *     be a lie (K6, the feel plan's decision 6). An arrow ALONG the parent's
 *     axis REORDERS it one place (`moveNode`, a STRUCTURAL edit). An arrow
 *     across the axis does nothing.
 *
 * This module holds the rules (pure) and the one layout read they need
 * (`measureArrowTarget`, through the frame adapters, so a live bridge frame
 * answers the same question a portal frame does). The key handling — the hold,
 * the preview, the one write on release — is `useCanvasNodeArrowKeys`.
 *
 * ## Which offsets a nudge writes (and why not always `left`/`top`)
 *
 * The computed value of an inset on a positioned element is its USED px value,
 * so the DOM cannot say whether `left` was authored or is `auto` (P2-D's
 * finding). Writing `left` onto an element the source anchors with `right`
 * over-constrains it: the source then carries both, and a later width change
 * moves the wrong edge. So the offsets come from what the source AUTHORED —
 * the node's inline styles over its class rules' base styles
 * (`authoredOffsets`) — and a nudge moves every authored offset on the axis:
 *
 *   - `right: 20px` alone → `right` moves (the element stays right-anchored);
 *   - `left` AND `right` (a stretched element) → both move, so it keeps its
 *     width instead of being resized;
 *   - nothing authored → `left` (`insetInlineStart` under RTL) and `top`, the
 *     same property a free move and a resize write (`inlineOffsetProperty`).
 *
 * The bases are the computed PHYSICAL insets; a logical one is read through
 * its physical side for the element's own direction. Authored styles this
 * module cannot see (a stylesheet that is not a parsed class rule) fall back
 * to the default pair, which is what every gesture wrote before.
 */
import {
  getAncestors,
  getParent,
  type CSSPropertyBag,
  type NodeTree,
  type PageNode,
  type StyleRule,
} from '@core/page-tree'
import {
  inlineOffsetProperty,
  isPositionedFreely,
  resolveCanvasAxisFromStyle,
  type CanvasAxisResolution,
} from '@core/studio-runtime'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { listFrameAdapterRegistrations } from './frameAdapter/canvasFrameAdapterRegistry'
import type { NodeMeasurement } from './frameAdapter/FrameDocumentAdapter'

/** An offset a nudge may write — a key of the element's `style={{…}}` object, so camelCase. */
export type NudgeOffsetProperty = 'left' | 'right' | 'insetInlineStart' | 'insetInlineEnd' | 'top' | 'bottom'

/** One offset a nudge moves: `base + sign × delta`, in CSS px. */
export interface NudgeTerm {
  property: NudgeOffsetProperty
  /** `+1` when a move to visual right / down GROWS this offset (`left`, `top`), `-1` when it shrinks it (`right`, `bottom`). */
  sign: 1 | -1
  base: number
}

export interface NudgePlan {
  horizontal: NudgeTerm[]
  vertical: NudgeTerm[]
}

export type ArrowMove =
  | { kind: 'nudge'; plan: NudgePlan }
  | { kind: 'reorder'; layout: CanvasAxisResolution }

/** The computed-style facts the rules read — plain strings, so the rules are testable without a DOM. */
export interface ArrowTargetStyle {
  position: string
  direction: string
  left: string
  right: string
  top: string
  bottom: string
}

export interface ArrowTargetMeasurement {
  own: ArrowTargetStyle
  /** The computed layout of the node's nearest boxed ancestor, or `null` when none could be read. */
  layout: { display: string; flexDirection: string; gridAutoFlow: string; direction: string } | null
}

const HORIZONTAL_OFFSETS = ['left', 'right', 'insetInlineStart', 'insetInlineEnd'] as const
const VERTICAL_OFFSETS = ['top', 'bottom'] as const

function isSetValue(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed !== '' && trimmed !== 'auto'
}

/** Top-level whitespace-separated values — a space inside `calc( … )` does not split. */
function splitCssValues(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /\s/.test(char)) {
      if (current) parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current) parts.push(current)
  return parts
}

/**
 * The four sides an `inset` shorthand sets, in the box order CSS gives its
 * one-to-four values (top, right, bottom, left). `inset: 124px 0 auto 0` sets
 * top, left and right, and leaves the bottom `auto` — writing a `bottom` there
 * would stretch the element instead of moving it.
 */
function insetSides(value: unknown): Record<'top' | 'right' | 'bottom' | 'left', unknown> {
  const values = typeof value === 'string' ? splitCssValues(value) : [value]
  const [top, right = top, bottom = top, left = right] = values
  return { top, right, bottom, left }
}

/**
 * The offsets the node's SOURCE sets: its class rules' base styles in
 * assignment order, then its inline styles — later wins, as in the cascade.
 * The `inset` shorthand sets the sides its values do not leave `auto`, and
 * a longhand after it overrides its side.
 */
export function authoredOffsets(
  node: Pick<PageNode, 'classIds' | 'inlineStyles'>,
  styleRules: Readonly<Record<string, StyleRule>> | undefined,
): Set<NudgeOffsetProperty> {
  const merged = new Map<string, unknown>()
  const apply = (bag: Readonly<Record<string, unknown>> | CSSPropertyBag | undefined) => {
    if (!bag) return
    const record = bag as Readonly<Record<string, unknown>>
    if ('inset' in record) {
      for (const [side, sideValue] of Object.entries(insetSides(record.inset))) merged.set(side, sideValue)
    }
    for (const property of [...HORIZONTAL_OFFSETS, ...VERTICAL_OFFSETS]) {
      if (property in record) merged.set(property, record[property])
    }
  }
  for (const classId of node.classIds) apply(styleRules?.[classId]?.styles)
  apply(node.inlineStyles)

  const authored = new Set<NudgeOffsetProperty>()
  for (const [property, value] of merged) {
    if (isSetValue(value)) authored.add(property as NudgeOffsetProperty)
  }
  return authored
}

/** The computed px value, or `0` for one the element does not resolve (it is not rendered). */
function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function horizontalTerm(property: NudgeOffsetProperty, style: ArrowTargetStyle): NudgeTerm {
  const rtl = style.direction === 'rtl'
  // A logical inset IS one physical side for this element's direction: the
  // inline start is the right edge under RTL.
  const physical =
    property === 'insetInlineStart' ? (rtl ? 'right' : 'left')
      : property === 'insetInlineEnd' ? (rtl ? 'left' : 'right')
        : property
  return {
    property,
    sign: physical === 'left' ? 1 : -1,
    base: px(physical === 'left' ? style.left : style.right),
  }
}

/** Which offsets a nudge writes, and from what — see the module doc. */
export function planNudge(style: ArrowTargetStyle, authored: ReadonlySet<NudgeOffsetProperty>): NudgePlan {
  const horizontalProperties = HORIZONTAL_OFFSETS.filter((property) => authored.has(property))
  const verticalProperties = VERTICAL_OFFSETS.filter((property) => authored.has(property))
  const horizontal = (horizontalProperties.length > 0 ? horizontalProperties : [inlineOffsetProperty(style.direction)])
    .map((property) => horizontalTerm(property, style))
  const vertical = (verticalProperties.length > 0 ? verticalProperties : ['top' as const]).map(
    (property): NudgeTerm => ({
      property,
      sign: property === 'top' ? 1 : -1,
      base: px(property === 'top' ? style.top : style.bottom),
    }),
  )
  return { horizontal, vertical }
}

/**
 * The inline-style patch for a nudge of (`dx`, `dy`) visual px from the plan's
 * bases — the preview while a key is held, and the one write on release. Only
 * the axes that moved are written.
 */
export function nudgeStylePatch(plan: NudgePlan, dx: number, dy: number): Record<string, string> {
  const patch: Record<string, string> = {}
  const write = (terms: readonly NudgeTerm[], delta: number) => {
    for (const term of terms) patch[term.property] = `${Math.round(term.base + term.sign * delta)}px`
  }
  if (dx !== 0) write(plan.horizontal, dx)
  if (dy !== 0) write(plan.vertical, dy)
  return patch
}

/** Nudge or reorder, from the measured layer. `authored` is only read for a nudge. */
export function resolveArrowMove(
  measured: ArrowTargetMeasurement,
  authored: ReadonlySet<NudgeOffsetProperty>,
): ArrowMove | null {
  if (isPositionedFreely(measured.own.position)) {
    return { kind: 'nudge', plan: planNudge(measured.own, authored) }
  }
  if (!measured.layout) return null
  return { kind: 'reorder', layout: resolveCanvasAxisFromStyle(measured.layout) }
}

/**
 * How many places an arrow moves a layout child among its siblings: `±1`
 * along the parent's axis (reversed for `*-reverse` and an RTL row, so the
 * layer moves the way the arrow points), `null` across it.
 */
export function reorderStep(layout: CanvasAxisResolution, delta: { dx: number; dy: number }): -1 | 1 | null {
  const along = layout.axis === 'horizontal' ? delta.dx : delta.dy
  if (along === 0) return null
  const forward = along > 0 ? 1 : -1
  return layout.reversed ? (-forward as -1 | 1) : forward
}

/**
 * Move a node one place among its siblings, through `moveNode` — the same
 * structural write-back gate every other reorder surface runs (`struct-01`),
 * so a refused move says the same sentence here as from a drag. Shared by the
 * arrows and by ⌥↑ / ⌥↓ / ⌘[ / ⌘] (`layers.moveUp` / `layers.moveDown`), so
 * the keyboard can never disagree with itself about what "one place" means.
 */
export function moveNodeAmongSiblings(nodeId: string, step: -1 | 1): void {
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  if (!page) return
  const parent = getParent(page, nodeId)
  if (!parent) return
  const index = parent.children.indexOf(nodeId)
  if (index === -1) return
  const next = index + step
  if (next < 0 || next > parent.children.length - 1) return
  store.moveNode(nodeId, parent.id, next)
}

const OWN_PROPERTIES = ['position', 'direction', 'left', 'right', 'top', 'bottom']
const LAYOUT_PROPERTIES = ['display', 'flex-direction', 'grid-auto-flow', 'direction']
const MEASURED_PROPERTIES = [...new Set([...OWN_PROPERTIES, ...LAYOUT_PROPERTIES])]

function readOwn(measurement: NodeMeasurement | undefined): ArrowTargetStyle {
  const style = measurement?.computedStyle ?? {}
  return {
    // A node with no element of its own (a component call site, rendered as a
    // Fragment) has no position of its own: it is in its parent's flow.
    position: measurement?.rect ? (style.position ?? 'static') : 'static',
    direction: style.direction ?? 'ltr',
    left: style.left ?? '',
    right: style.right ?? '',
    top: style.top ?? '',
    bottom: style.bottom ?? '',
  }
}

/**
 * The one layout read an arrow press makes: the node's position and insets,
 * and the layout of its nearest BOXED ancestor (a `display: contents` host
 * lays nothing out — `dropAxisRules.ts`'s `findLayoutParent` skips it for the
 * same reason). One `measure` per frame for the node and its whole ancestor
 * chain, so a bridge frame pays one round trip.
 *
 * The frame is the one rendering the node at the active breakpoint when there
 * is one, else the first that renders it. `null` when no frame does.
 */
export async function measureArrowTarget(
  tree: NodeTree<PageNode>,
  nodeId: string,
  preferredBreakpointId: string,
): Promise<ArrowTargetMeasurement | null> {
  const ancestorIds = getAncestors(tree, nodeId).map((ancestor) => ancestor.id).reverse()
  const refs = [{ nodeId }, ...ancestorIds.map((id) => ({ nodeId: id }))]
  const registrations = [...listFrameAdapterRegistrations().values()].sort(
    (a, b) => Number(b.breakpointId === preferredBreakpointId) - Number(a.breakpointId === preferredBreakpointId),
  )
  const answers = await Promise.all(
    registrations.map((registration) =>
      registration.adapter.measure(refs, MEASURED_PROPERTIES).catch((_err: unknown) => {
        // A bridge frame that does not answer in time (its dev server is
        // reloading) simply is not the frame this press reads.
        return null
      }),
    ),
  )
  // The frame that renders the node — or, for a node with no element of its
  // own, its parent — is the frame showing this page.
  const measurements = answers.find((answer) => answer?.[0]?.rect || answer?.[1]?.rect)
  if (!measurements) return null

  let layout: ArrowTargetMeasurement['layout'] = null
  for (const ancestor of measurements.slice(1)) {
    const style = ancestor.computedStyle
    if (!ancestor.rect || style.display === 'contents') continue
    layout = {
      display: style.display ?? '',
      flexDirection: style['flex-direction'] ?? '',
      gridAutoFlow: style['grid-auto-flow'] ?? '',
      direction: style.direction ?? 'ltr',
    }
    break
  }
  return { own: readOwn(measurements[0]), layout }
}
