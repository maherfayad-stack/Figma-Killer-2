/**
 * constraintMapping — the pure model behind Figma's constraints crosshair
 * (W8-4, `STUDIO-WAVE7-PLAN.md`). One module owns BOTH directions:
 *
 *   - read-back:  a style bag → which constraint each axis is currently in
 *   - write:      a constraint choice + the current bag → one CSS patch,
 *                 or a NAMED REFUSAL when no honest patch exists
 *
 * No React, no store, no DOM — everything the mapping needs is passed in as
 * data, so every rule below is unit-testable and there is exactly one place
 * to read when a mapping looks wrong.
 *
 * The five constraints, and the CSS each one actually is
 * -----------------------------------------------------
 *   start   (Left / Top)          the start inset set, the end inset cleared
 *   end     (Right / Bottom)      the end inset set, the start inset cleared
 *   stretch (Left and right)      BOTH insets set, `width`/`height` cleared —
 *                                 the element is defined by its two edges, so
 *                                 a size declaration would fight them
 *   center                        `left: 50%` plus a −50% pull-back
 *   scale                         both insets expressed as PERCENTAGES of the
 *                                 containing block, `width`/`height` cleared
 *
 * Why the pull-back is the standalone `translate` property, not `transform`
 * ------------------------------------------------------------------------
 * Same reason `RotationRow` writes the standalone `rotate` and `flipValue.ts`
 * writes the standalone `scale`: `translate` is its own declaration with its
 * own value, so centring is one honest write to one honest place. Reaching
 * into a `transform` function list would mean parsing an ordered,
 * arbitrary-length grammar and rewriting one item of it — the "silently
 * rewrite CSS we only partly understood" failure this panel refuses
 * everywhere else.
 *
 * That choice creates exactly two collisions, and both REFUSE rather than
 * guess (the reason is surfaced as the control's tooltip, §8.4's
 * disabled-with-a-reason posture — never a silently missing control):
 *
 *   1. `transform` already carries a translate-family function. CSS applies
 *      `translate` first and then `transform`, so writing both would move the
 *      element twice and the user would see neither value alone.
 *   2. `translate` already carries a value on THIS axis that isn't ours. A
 *      `-50%` is ours (it is exactly what centring writes); anything else —
 *      `10px`, a `var()`, a `calc()`, a third z component — is somebody's
 *      real value and centring would destroy it.
 *
 * Scale needs a measurement, so it refuses without one
 * ----------------------------------------------------
 * Percent insets can only be derived from the used pixel insets and the
 * containing block's size. When no live canvas frame is rendering the node
 * there is nothing to measure, and inventing a percentage would move the
 * element. `geometry: null` therefore refuses Scale by name instead of
 * writing a plausible-looking lie.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The two constrained axes. `x` is left/right, `y` is top/bottom. */
export type ConstraintAxis = 'x' | 'y'

/** Figma's five per-axis constraints, in the order the crosshair offers them. */
export type ConstraintMode = 'start' | 'end' | 'stretch' | 'center' | 'scale'

export const ALL_CONSTRAINT_MODES: readonly ConstraintMode[] = ['start', 'end', 'stretch', 'center', 'scale']

/** The three CSS properties one axis owns. */
export interface AxisProperties {
  start: 'left' | 'top'
  end: 'right' | 'bottom'
  size: 'width' | 'height'
}

export const AXIS_PROPERTIES: Record<ConstraintAxis, AxisProperties> = {
  x: { start: 'left', end: 'right', size: 'width' },
  y: { start: 'top', end: 'bottom', size: 'height' },
}

/**
 * Live geometry for one axis, read off the canvas frame's real computed
 * style. `null` on the context means "no frame is rendering this node" — the
 * same "no frame truth available" signal `useFrameComputedStyleValues`
 * returns, and callers must treat it as unknown, never as zero.
 */
export interface AxisGeometry {
  /** Used inset from the containing block's start edge, in px. */
  startPx: number
  /** Used inset from the containing block's end edge, in px. */
  endPx: number
  /** The containing block's size along this axis, in px. Must be > 0 to convert to %. */
  containerPx: number
}

export interface ConstraintContext {
  /** What the bag being edited (a class rule, or the node's inline styles) DECLARES. */
  stored: Record<string, unknown>
  /** The element's EFFECTIVE values — declared plus whatever it inherits/computes. */
  current: Record<string, unknown>
  /** Per-axis live measurement, or `null` when no canvas frame is rendering the node. */
  geometry: AxisGeometry | null
}

/**
 * A CSS patch. `null` means "clear this declaration" — the same convention
 * the panel's hover-preview channel already uses, so a patch can be replayed
 * through either `onChange` or `onClearProperty` without a second encoding.
 */
export type ConstraintPatch = Record<string, string | null>

export type ConstraintPlan = { ok: true; patch: ConstraintPatch } | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Positioned-context gate
// ---------------------------------------------------------------------------

export interface PositionedContextInput {
  /** The node's effective `position`. */
  position: string | null
  /**
   * Does the node's own parent establish its containing block (it is
   * positioned, or it has a `transform`/`filter` that makes it one)?
   * `null` means unverifiable — no live canvas frame is rendering the parent.
   */
  parentIsContainingBlock: boolean | null
}

export type PositionedContext = { ok: true } | { ok: false; reason: string }

/**
 * The gate the whole constraints cluster hangs on. Constraints describe a
 * box's relationship to ITS PARENT's box; that relationship only exists when
 * the parent is the box's containing block.
 *
 *   - `fixed` is always fine: the containing block is the viewport, which is
 *     a real, stable frame of reference even though it isn't the parent.
 *   - `absolute` is fine only when the parent really is the containing
 *     block. Otherwise the offsets anchor to some further ancestor (or the
 *     page), and a crosshair pointing at "the parent" would be lying.
 *   - Anything else is in normal flow, where insets either do nothing
 *     (`static`) or nudge the box away from a position it still occupies
 *     (`relative`/`sticky`) — neither is the constraints metaphor.
 *   - Unverifiable stays disabled, matching `resolveAlignWrite`'s
 *     "Can't verify the parent's layout." posture: no frame, no claim.
 */
export function resolvePositionedContext({
  position,
  parentIsContainingBlock,
}: PositionedContextInput): PositionedContext {
  if (position === 'fixed') return { ok: true }
  if (position !== 'absolute') {
    return {
      ok: false,
      reason: 'Constraints need position: absolute or fixed — this element is laid out in normal flow.',
    }
  }
  if (parentIsContainingBlock === null) {
    return {
      ok: false,
      reason: "Can't verify this element's containing block — no live canvas frame is rendering its parent yet.",
    }
  }
  if (!parentIsContainingBlock) {
    return {
      ok: false,
      reason:
        "This element's parent isn't positioned, so these offsets anchor to a further ancestor, not to the parent. Set the parent to position: relative first.",
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// translate parsing — the one shared target centring writes into
// ---------------------------------------------------------------------------

/** Matches `translate(`, `translateX/Y/Z(`, `translate3d(` — every translate-family FUNCTION name. */
export const TRANSFORM_TRANSLATE_FN_RE = /\btranslate(?:3d|[xyz])?\s*\(/i

/** Our own pull-back component. Written by centring, and released by every other mode. */
const CENTER_PULL_BACK = '-50%'

/** The start inset centring writes. Read-back requires this exact value. */
const CENTER_INSET = '50%'

const ZERO_ISH = new Set(['', '0', '0px', '0%', '0em', '0rem'])

function isZeroish(component: string): boolean {
  return ZERO_ISH.has(component.trim().toLowerCase())
}

/**
 * Split a `translate` value into its X and Y components. Returns `null` for
 * anything this control must not touch: a three-component (3D) translate,
 * whose Z we would have to drop, or a value we cannot split on whitespace
 * because it contains a function call like `calc(1px + 2px)`.
 */
export function parseTranslateAxes(value: unknown): { x: string; y: string } | null {
  if (value == null) return { x: '0', y: '0' }
  const trimmed = String(value).trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return { x: '0', y: '0' }
  // A parenthesised component (calc/var/min/…) can contain spaces of its own,
  // so whitespace is not a safe separator. Refuse rather than mis-split.
  if (trimmed.includes('(')) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length > 2) return null
  return { x: parts[0]!, y: parts.length === 2 ? parts[1]! : '0' }
}

/**
 * Rebuild a `translate` value from its components, or `undefined` when both
 * are zero — an un-centred element gets no `translate` declaration at all
 * rather than a no-op `translate: 0 0` left in the user's stylesheet.
 */
export function serializeTranslateAxes(axes: { x: string; y: string }): string | undefined {
  const x = isZeroish(axes.x) ? '0' : axes.x.trim()
  const y = isZeroish(axes.y) ? '0' : axes.y.trim()
  if (x === '0' && y === '0') return undefined
  if (y === '0') return x
  return `${x} ${y}`
}

/** The effective value of one property: what this bag declares, else what the element computes. */
function effective(ctx: ConstraintContext, property: string): unknown {
  const stored = ctx.stored[property]
  if (stored !== undefined && stored !== null && stored !== '') return stored
  return ctx.current[property]
}

function declared(ctx: ConstraintContext, property: string): string | undefined {
  const v = ctx.stored[property]
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string' && v !== '') return v
  return undefined
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

const PERCENT_RE = /^-?(\d+\.?\d*|\.\d+)%$/

/**
 * Which constraint this axis is currently in, according to what the edited
 * bag DECLARES. `null` means "no constraint declared here" — the honest
 * answer for an element whose offsets all come from somewhere else, and the
 * reason the crosshair shows no active segment rather than guessing one.
 *
 * Order matters: centring declares a start inset too, so it has to be
 * recognised before the plain `start` case can claim it.
 */
export function readConstraintMode(axis: ConstraintAxis, ctx: ConstraintContext): ConstraintMode | null {
  const props = AXIS_PROPERTIES[axis]
  const start = declared(ctx, props.start)
  const end = declared(ctx, props.end)

  if (start !== undefined && end !== undefined) {
    return PERCENT_RE.test(start.trim()) && PERCENT_RE.test(end.trim()) ? 'scale' : 'stretch'
  }
  if (start !== undefined) {
    if (start.trim() === CENTER_INSET && translateComponent(ctx, axis) === CENTER_PULL_BACK) return 'center'
    return 'start'
  }
  if (end !== undefined) return 'end'
  return null
}

/** This axis's component of the element's effective `translate`, or `null` if unreadable. */
function translateComponent(ctx: ConstraintContext, axis: ConstraintAxis): string | null {
  const axes = parseTranslateAxes(effective(ctx, 'translate'))
  if (!axes) return null
  return (axis === 'x' ? axes.x : axes.y).trim()
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Why this mode has no honest patch on this axis, or `null` when it does.
 * Callers render the string as the disabled control's tooltip.
 */
export function constraintRefusal(axis: ConstraintAxis, mode: ConstraintMode, ctx: ConstraintContext): string | null {
  if (mode === 'scale') {
    if (!ctx.geometry) {
      return "Scale needs the containing block measured on the canvas — no live frame is reporting one for this element yet."
    }
    if (!(ctx.geometry.containerPx > 0)) {
      return "This element's container measures 0px on this axis, so a percentage offset has nothing to scale against."
    }
    return null
  }
  if (mode === 'center') return centerRefusal(axis, ctx)
  // start / end / stretch write only real inset properties. The one shared
  // target they touch is the pull-back, and they only ever RELEASE one this
  // control itself wrote (`readConstraintMode` proves it is a plain `-50%`
  // before calling it centred). A `translate` we cannot split is therefore
  // never ours, and is left exactly as the user wrote it — nothing to refuse.
  return null
}

/**
 * Centring's two collisions (see the module doc). Both are about the ONE
 * shared write target — the pull-back — never about the inset.
 */
function centerRefusal(axis: ConstraintAxis, ctx: ConstraintContext): string | null {
  const transform = effective(ctx, 'transform')
  if (typeof transform === 'string' && TRANSFORM_TRANSLATE_FN_RE.test(transform)) {
    return `This element is already moved by a translate inside its transform (${transform.trim()}) — centring would add a second, compounding shift on top of it.`
  }
  const raw = effective(ctx, 'translate')
  const axes = parseTranslateAxes(raw)
  if (!axes) {
    return `This element's translate (${String(raw).trim()}) isn't a value we can rewrite one axis of without losing the rest.`
  }
  const component = (axis === 'x' ? axes.x : axes.y).trim()
  if (!isZeroish(component) && component !== CENTER_PULL_BACK) {
    return `This element already has a ${axis.toUpperCase()}-axis translate of ${component} — centring would overwrite it.`
  }
  return null
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * The patch that puts this axis into `mode`, or a named refusal.
 *
 * Every mode preserves the element's CURRENT position where it can: the
 * inset it writes is the one the element already has (measured off the frame
 * when available, else whatever the bag declares, else `0px`), so changing
 * which edge anchors the element does not also teleport it.
 */
export function planConstraintChange(
  axis: ConstraintAxis,
  mode: ConstraintMode,
  ctx: ConstraintContext,
): ConstraintPlan {
  const refusal = constraintRefusal(axis, mode, ctx)
  if (refusal) return { ok: false, reason: refusal }

  const props = AXIS_PROPERTIES[axis]
  const patch: ConstraintPatch = {}

  if (mode === 'center') {
    patch[props.start] = CENTER_INSET
    patch[props.end] = null
    // `centerRefusal` already proved this axis's component is ours to write,
    // so this is always a real value — the guard is the type, not a doubt.
    const pullBack = writeTranslate(ctx, axis, CENTER_PULL_BACK)
    if (pullBack !== undefined) patch.translate = pullBack
    return { ok: true, patch }
  }

  // Anything but centring must give the pull-back back.
  const released = writeTranslate(ctx, axis, '0')
  if (released !== undefined) patch.translate = released

  if (mode === 'start') {
    patch[props.start] = resolveInset(ctx, props.start, ctx.geometry?.startPx)
    patch[props.end] = null
    return { ok: true, patch }
  }
  if (mode === 'end') {
    patch[props.start] = null
    patch[props.end] = resolveInset(ctx, props.end, ctx.geometry?.endPx)
    return { ok: true, patch }
  }
  if (mode === 'stretch') {
    patch[props.start] = resolveInset(ctx, props.start, ctx.geometry?.startPx)
    patch[props.end] = resolveInset(ctx, props.end, ctx.geometry?.endPx)
    patch[props.size] = null
    return { ok: true, patch }
  }
  // scale — `constraintRefusal` already proved the geometry is measurable.
  const geometry = ctx.geometry!
  patch[props.start] = toPercent(geometry.startPx, geometry.containerPx)
  patch[props.end] = toPercent(geometry.endPx, geometry.containerPx)
  patch[props.size] = null
  return { ok: true, patch }
}

/**
 * The `translate` cell of a patch: this axis set to `component`, the OTHER
 * axis left exactly as the element had it. `null` clears the declaration
 * (both axes ended up at zero); `undefined` means the patch shouldn't carry
 * `translate` at all, which is the common case — nothing was centred, so
 * there is nothing to release.
 */
function writeTranslate(ctx: ConstraintContext, axis: ConstraintAxis, component: string): string | null | undefined {
  const axes = parseTranslateAxes(effective(ctx, 'translate'))
  if (!axes) return undefined
  const next = axis === 'x' ? { x: component, y: axes.y } : { x: axes.x, y: component }
  const serialized = serializeTranslateAxes(next)
  if (serialized === undefined) {
    // Nothing left to declare. Only emit the clear when there IS a
    // declaration to clear, so a plain "anchor left" edit doesn't drag an
    // unrelated `translate` removal into the same undo entry.
    return ctx.stored.translate !== undefined && ctx.stored.translate !== null && ctx.stored.translate !== ''
      ? null
      : undefined
  }
  return serialized
}

/**
 * The value to write for one inset: the frame's measured used value when we
 * have it (that is the pixel truth the user sees), else whatever the bag
 * already declares, else a plain `0px`.
 */
function resolveInset(ctx: ConstraintContext, property: string, measuredPx: number | undefined): string {
  if (measuredPx !== undefined && Number.isFinite(measuredPx)) return `${roundPx(measuredPx)}px`
  const declaredValue = declared(ctx, property)
  if (declaredValue !== undefined) return declaredValue
  return '0px'
}

function roundPx(px: number): number {
  return Math.round(px * 100) / 100
}

/** A used pixel inset as a percentage of the containing block, to 2 decimals. */
function toPercent(px: number, containerPx: number): string {
  const pct = Math.round((px / containerPx) * 10000) / 100
  return `${pct}%`
}

// ---------------------------------------------------------------------------
// Crosshair interaction
// ---------------------------------------------------------------------------

/**
 * What clicking one edge of the crosshair means, given what the axis is
 * already in. This is Figma's own toggle semantics, stated once as data:
 *
 *   - clicking an unpinned edge PINS it (and pairs with an already-pinned
 *     opposite edge to become the stretch constraint);
 *   - clicking a pinned edge UNPINS it — with the opposite edge still pinned
 *     that leaves the single opposite pin, and with nothing left pinned the
 *     axis falls to Scale, exactly as Figma treats "no pins on this axis";
 *   - clicking any edge while centred replaces centring with that pin, since
 *     an element cannot be both centred and edge-anchored on one axis.
 */
export function nextModeForEdgeToggle(current: ConstraintMode | null, edge: 'start' | 'end'): ConstraintMode {
  if (current === 'stretch') return edge === 'start' ? 'end' : 'start'
  if (current === edge) return 'scale'
  if (current === 'start' || current === 'end') return 'stretch'
  return edge
}
