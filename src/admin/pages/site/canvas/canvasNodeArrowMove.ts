/**
 * canvasNodeArrowMove — what an arrow key does to the selected layer (P2-C,
 * IX-1; the flow nudge since canvas-48). Figma's rule, in CSS terms:
 *
 *   - a layer that is `position: absolute | fixed` NUDGES: its offsets move by
 *     1 px, or 10 with ⇧. The write is one inline style — the element's own
 *     `style={{…}}`, one honest target — so it is a VALUE edit;
 *   - a flow child of an AUTO-LAYOUT parent (`flex` / `grid`, inline or not)
 *     is placed by that parent, so moving it by a pixel would be a lie (K6).
 *     An arrow ALONG the parent's axis REORDERS it one place (`stepSiblings`
 *     → the Layers panel's `moveNodes`, a STRUCTURAL edit). An arrow across
 *     the axis does nothing;
 *   - any OTHER flow layer (its parent is `block`, `inline`, `flow-root`, a
 *     table …) NUDGES too, through `position: relative` (canvas-48, the
 *     owner's ask: "if it's not flex, move it 1px"). See "The flow nudge".
 *
 * A multi-selection (P2-C2, OD-16) follows the same rule per layer —
 * `resolveArrowSelectionMove` below says what a MIXED selection does — and a
 * grid child steps a whole row on ↑ / ↓ (`reorderStep`).
 *
 * ## The flow nudge (canvas-48) — why `position: relative`
 *
 * A layer in block flow has no offset that places it. Of the properties that
 * could move it by one pixel, only a RELATIVE offset moves THAT element and
 * nothing else: `margin` shifts every following sibling (and collapses with a
 * neighbour's, so a 1 px step can render as 0), `transform` makes the element
 * the containing block of its `fixed` descendants and fights any authored
 * transform, and `position: absolute` (the ⌘-drag's promotion) pulls it out of
 * flow so its siblings close the gap. `position: relative` + `top` / `left`
 * keeps the element's slot in the flow and paints it offset from it — exactly
 * what a 1 px nudge means.
 *
 *   - already `relative`: its authored offsets move, as for an absolute layer;
 *   - `static`: the write adds `position: relative`, and its offsets start from
 *     ZERO (a static element's computed `top` is whatever was authored, which
 *     `static` ignores). An offset the source authored but `static` ignored
 *     would wake up with the promotion, so the patch pins that axis's default
 *     property to `0px` (`NudgePlan.fixed`) — the element moves by exactly the
 *     step, on the axis the arrow points;
 *   - `sticky`: refused — its offsets are stick thresholds, not a position;
 *   - no box of its own (`display: contents`, a component call site rendered
 *     as a Fragment): refused — an offset there does nothing at all;
 *   - promoting it would re-anchor an absolutely positioned descendant (one
 *     whose containing block is currently ABOVE this layer): refused, because
 *     that descendant would jump (`reanchorsAbsoluteDescendant`).
 *
 * This module holds the rules (pure) and the one layout read they need
 * (`measureArrowTargets`, through the frame adapters, so a live bridge frame
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
  topLevelSelection,
  type CSSPropertyBag,
  type NodeTree,
  type PageNode,
  type StyleRule,
} from '@core/page-tree'
import {
  inlineOffsetProperty,
  isPositionedFreely,
  resolveCanvasAxisFromStyle,
} from '@core/studio-runtime'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { measureInRenderingFrame } from './canvasSelectionMeasure'
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
  /**
   * Declarations every non-empty patch carries, under the moving terms: a flow
   * nudge's `position: relative`, and the `0px` pins that keep an offset the
   * source authored under `static` from waking up with it (canvas-48).
   */
  fixed?: Readonly<Record<string, string>>
}

/** The computed-style facts the rules read — plain strings, so the rules are testable without a DOM. */
export interface ArrowTargetStyle {
  position: string
  direction: string
  left: string
  right: string
  top: string
  bottom: string
}

/** The computed layout of a layer's nearest boxed ancestor — what decides which way a reorder goes. */
export interface ArrowParentLayout {
  display: string
  flexDirection: string
  gridAutoFlow: string
  direction: string
  /** Resolved track counts of a grid (`1` for anything else) — a grid row step (P2-C2). */
  gridColumns: number
  gridRows: number
}

export interface ArrowTargetMeasurement {
  own: ArrowTargetStyle
  /** `null` when no boxed ancestor could be read. */
  layout: ArrowParentLayout | null
  /** The layer renders a box of its own — an offset on it can move something (canvas-48). */
  boxed: boolean
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
  const patch: Record<string, string> = dx !== 0 || dy !== 0 ? { ...plan.fixed } : {}
  const write = (terms: readonly NudgeTerm[], delta: number) => {
    for (const term of terms) patch[term.property] = `${Math.round(term.base + term.sign * delta)}px`
  }
  if (dx !== 0) write(plan.horizontal, dx)
  if (dy !== 0) write(plan.vertical, dy)
  return patch
}


/**
 * The plan of a FLOW layer's nudge (canvas-48) — see "The flow nudge" in the
 * module doc. Already `relative`: its authored offsets, from their used
 * values, exactly as for an absolute layer. `static`: promoted to `relative`,
 * its default offsets from zero, and every axis the source authored an offset
 * on (ignored until now) pinned to `0px`, so only the arrow's axis moves.
 */
export function planFlowNudge(style: ArrowTargetStyle, authored: ReadonlySet<NudgeOffsetProperty>): NudgePlan {
  if (style.position === 'relative') return planNudge(style, authored)
  const horizontalProperty = inlineOffsetProperty(style.direction)
  const fixed: Record<string, string> = { position: 'relative' }
  // `left` beats `right`, and under RTL the inline start (`right`) beats
  // `left`; `top` beats `bottom`. So one pin per axis silences every offset
  // the source authored there.
  if (HORIZONTAL_OFFSETS.some((property) => authored.has(property))) fixed[horizontalProperty] = '0px'
  if (VERTICAL_OFFSETS.some((property) => authored.has(property))) fixed.top = '0px'
  return {
    // `insetInlineStart` is the RIGHT edge under RTL: visual right shrinks it.
    horizontal: [{ property: horizontalProperty, sign: horizontalProperty === 'left' ? 1 : -1, base: 0 }],
    vertical: [{ property: 'top', sign: 1, base: 0 }],
    fixed,
  }
}

/** A parent that PLACES its flow children (`flex` / `grid`, inline or not) — the arrows reorder there. */
export function isAutoLayout(layout: ArrowParentLayout | null): layout is ArrowParentLayout {
  return layout !== null && (layout.display.includes('flex') || layout.display.includes('grid'))
}

/** Why a flow layer has no pixel an arrow could move (canvas-48). */
export type FlowNudgeRefusal = 'sticky' | 'unboxed' | 'reanchors'

/**
 * What an arrow does to the whole selection (P2-C2, OD-16; canvas-48):
 *
 *   - a member that is `absolute | fixed`, or a flow member whose parent is
 *     NOT auto-layout, NUDGES. If any member nudges, every nudging member
 *     moves by the same delta, each through its own offsets, and an
 *     auto-layout child of a MIXED selection stays where its parent places
 *     it — it has no pixel position to move (Penpot's `move-selected` rule);
 *   - every member is an auto-layout child → `reorder`: each moves along ITS
 *     parent's axis (`reorderStep`), so a selection spanning a row and a
 *     column moves only the members the arrow points along;
 *   - a member the flow nudge must refuse (`FlowNudgeRefusal`) refuses the
 *     whole press — a selection moves together or not at all.
 *
 * The page's root has no parent to move within and is left out.
 */
export type ArrowSelectionMove =
  | { kind: 'nudge'; plans: ReadonlyMap<string, NudgePlan> }
  | { kind: 'reorder'; layouts: ReadonlyMap<string, ArrowParentLayout> }
  | { kind: 'refuse'; nodeId: string; reason: FlowNudgeRefusal }

/** `null` when nothing was measured. `measured` is keyed by node id; `layouts` by TREE parent id. */
export function resolveArrowSelectionMove(
  tree: NodeTree<PageNode>,
  measured: ReadonlyMap<string, ArrowTargetMeasurement>,
  styleRules: Readonly<Record<string, StyleRule>> | undefined,
): ArrowSelectionMove | null {
  if (measured.size === 0) return null
  const plans = new Map<string, NudgePlan>()
  const layouts = new Map<string, ArrowParentLayout>()
  for (const [nodeId, measurement] of measured) {
    const node = tree.nodes[nodeId]
    if (!node) continue
    const { own, layout } = measurement
    if (isPositionedFreely(own.position)) {
      plans.set(nodeId, planNudge(own, authoredOffsets(node, styleRules)))
      continue
    }
    if (!node.parentId) continue
    if (isAutoLayout(layout)) {
      layouts.set(node.parentId, layout)
      continue
    }
    if (own.position === 'sticky') return { kind: 'refuse', nodeId, reason: 'sticky' }
    if (!measurement.boxed) return { kind: 'refuse', nodeId, reason: 'unboxed' }
    plans.set(nodeId, planFlowNudge(own, authoredOffsets(node, styleRules)))
  }
  if (plans.size > 0) return { kind: 'nudge', plans }
  return { kind: 'reorder', layouts }
}

/** The plans that promote a `static` layer to `relative` — the ones `findReanchoringPromotion` checks. */
export function promotedNodeIds(plans: ReadonlyMap<string, NudgePlan>): string[] {
  return [...plans].filter(([, plan]) => plan.fixed?.position === 'relative').map(([nodeId]) => nodeId)
}

/**
 * Would promoting `nodeId` to `position: relative` re-anchor an absolutely
 * positioned descendant? Such a descendant's containing block is ABOVE this
 * layer today exactly when no layer between them is positioned, so the walk
 * descends only through `static` layers (a layer with no element of its own
 * is walked through, as the browser does). `positionOf` answers a node's
 * computed `position`; an unmeasured one counts as `static`.
 */
export function reanchorsAbsoluteDescendant(
  tree: NodeTree<PageNode>,
  nodeId: string,
  positionOf: (id: string) => string | undefined,
): boolean {
  const pending = [...(tree.nodes[nodeId]?.children ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    const position = positionOf(id) ?? 'static'
    if (position === 'absolute') return true
    if (position === 'static') pending.push(...(tree.nodes[id]?.children ?? []))
  }
  return false
}

function descendantIds(tree: NodeTree<PageNode>, nodeId: string): string[] {
  const ids: string[] = []
  const pending = [...(tree.nodes[nodeId]?.children ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    ids.push(id)
    pending.push(...(tree.nodes[id]?.children ?? []))
  }
  return ids
}

/**
 * The layer among `promotedIds` whose promotion to `relative` would move an
 * absolutely positioned descendant, or `null` when none would. ONE `measure`
 * of every descendant's `position`, in the frame rendering the layers — paid
 * only by a press that promotes a `static` layer with children.
 */
export async function findReanchoringPromotion(
  tree: NodeTree<PageNode>,
  promotedIds: readonly string[],
  preferredBreakpointId: string,
): Promise<string | null> {
  const descendants = promotedIds.flatMap((id) => descendantIds(tree, id))
  if (descendants.length === 0) return null
  const byId = await measureInRenderingFrame([...promotedIds, ...descendants], ['position'], preferredBreakpointId, promotedIds)
  if (!byId) return null
  const positionOf = (id: string) => {
    const measurement = byId.get(id)
    return measurement?.rect ? measurement.computedStyle.position : undefined
  }
  return promotedIds.find((id) => reanchorsAbsoluteDescendant(tree, id, positionOf)) ?? null
}

/** How many tracks a resolved `grid-template-*` names — `none` (an implicit grid) is one. */
function trackCount(resolved: string): number {
  const trimmed = resolved.trim()
  if (trimmed === '' || trimmed === 'none') return 1
  // A resolved template is a plain list of sizes; `[line names]` are dropped first.
  return Math.max(1, splitCssValues(trimmed.replace(/\[[^\]]*\]/g, ' ')).length)
}

/**
 * How many places an arrow moves a layout child among its siblings, or
 * `null` when the arrow is across the axis.
 *
 *   - flex / block: `±1` along the axis — reversed for `*-reverse` and an RTL
 *     row, so the layer moves the way the arrow points
 *     (`resolveCanvasAxisFromStyle`);
 *   - grid (P2-C2): the flow axis steps `±1`, and the other axis steps a
 *     whole track — ↑ / ↓ move a row-flow item by the resolved column count,
 *     ← / → move a column-flow item by the row count. Under RTL the columns
 *     run right to left, so ← / → are mirrored.
 */
export function reorderStep(layout: ArrowParentLayout, delta: { dx: number; dy: number }): number | null {
  const sign = (value: number) => (value > 0 ? 1 : -1)
  if (layout.display.includes('grid')) {
    const mirror = layout.direction === 'rtl' ? -1 : 1
    const columnFlow = layout.gridAutoFlow.includes('column')
    if (delta.dx !== 0) return sign(delta.dx) * mirror * (columnFlow ? layout.gridRows : 1)
    if (delta.dy !== 0) return sign(delta.dy) * (columnFlow ? 1 : layout.gridColumns)
    return null
  }
  const axis = resolveCanvasAxisFromStyle(layout)
  const along = axis.axis === 'horizontal' ? delta.dx : delta.dy
  if (along === 0) return null
  return axis.reversed ? -sign(along) : sign(along)
}

/** The per-parent steps of a reorder, keyed by tree parent id — what `stepSiblings` takes. */
export function reorderSteps(
  layouts: ReadonlyMap<string, ArrowParentLayout>,
  delta: { dx: number; dy: number },
): Record<string, number> {
  const steps: Record<string, number> = {}
  for (const [parentId, layout] of layouts) {
    const step = reorderStep(layout, delta)
    if (step !== null) steps[parentId] = step
  }
  return steps
}

/**
 * Move the selection one place earlier / later in its parents' child order —
 * ⌥↑ / ⌥↓, ⌘[ / ⌘] and the palette's Move up / down. Order, not geometry:
 * "up" is one place earlier, whatever the layout. Every layer of a
 * multi-selection moves (P2-C2), through the same `stepSiblings` the arrows
 * use, so the keyboard can never disagree with itself about "one place".
 */
export function stepSelectionAmongSiblings(nodeIds: readonly string[], step: -1 | 1): void {
  const store = useEditorStore.getState()
  const page = selectActiveCanvasPage(store)
  if (!page) return
  const steps: Record<string, number> = {}
  for (const id of topLevelSelection(page, nodeIds)) {
    const parentId = page.nodes[id]?.parentId
    if (parentId) steps[parentId] = step
  }
  store.stepSiblings([...nodeIds], steps)
}

/** The computed properties `readOwn` and `readLayout` read — kebab-case, the wire's spelling. */
export const OWN_PROPERTIES = ['position', 'direction', 'left', 'right', 'top', 'bottom']
export const LAYOUT_PROPERTIES = ['display', 'flex-direction', 'grid-auto-flow', 'grid-template-columns', 'grid-template-rows', 'direction']
const MEASURED_PROPERTIES = [...new Set([...OWN_PROPERTIES, ...LAYOUT_PROPERTIES])]

export function readOwn(measurement: NodeMeasurement | undefined): ArrowTargetStyle {
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

export function readLayout(chain: readonly (NodeMeasurement | undefined)[]): ArrowParentLayout | null {
  for (const ancestor of chain) {
    const style = ancestor?.computedStyle
    if (!ancestor?.rect || !style || style.display === 'contents') continue
    return {
      display: style.display ?? '',
      flexDirection: style['flex-direction'] ?? '',
      gridAutoFlow: style['grid-auto-flow'] ?? '',
      direction: style.direction ?? 'ltr',
      gridColumns: trackCount(style['grid-template-columns'] ?? ''),
      gridRows: trackCount(style['grid-template-rows'] ?? ''),
    }
  }
  return null
}

/**
 * The one layout read an arrow press makes, for every selected layer: its
 * position and insets, and the layout of its nearest BOXED ancestor (a
 * `display: contents` host lays nothing out — `dropAxisRules.ts`'s
 * `findLayoutParent` skips it for the same reason). ONE `measure` per frame
 * for the layers and their ancestor chains together, so a bridge frame pays
 * one round trip however large the selection.
 *
 * The frame is the one rendering the first layer at the active breakpoint
 * when there is one, else the first that renders it. `null` when no frame
 * does. Keyed by node id.
 */
export async function measureArrowTargets(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  preferredBreakpointId: string,
): Promise<Map<string, ArrowTargetMeasurement> | null> {
  const chains = new Map(
    nodeIds.map((nodeId) => [nodeId, getAncestors(tree, nodeId).map((ancestor) => ancestor.id).reverse()] as const),
  )
  const refIds = nodeIds.flatMap((nodeId) => [nodeId, ...(chains.get(nodeId) ?? [])])
  const [firstId] = nodeIds
  const firstParentId = firstId ? chains.get(firstId)?.[0] : undefined
  // The frame that renders the first layer — or, for a layer with no element
  // of its own, its parent — is the frame showing this page.
  const anchors = [firstId, firstParentId].filter((id): id is string => id !== undefined)
  const byId = await measureInRenderingFrame(refIds, MEASURED_PROPERTIES, preferredBreakpointId, anchors)
  if (!byId) return null
  const measured = new Map<string, ArrowTargetMeasurement>()
  for (const nodeId of nodeIds) {
    const chain = (chains.get(nodeId) ?? []).map((id) => byId.get(id))
    const own = byId.get(nodeId)
    measured.set(nodeId, {
      own: readOwn(own),
      layout: readLayout(chain),
      boxed: own?.rect != null && own.computedStyle.display !== 'contents',
    })
  }
  return measured
}
