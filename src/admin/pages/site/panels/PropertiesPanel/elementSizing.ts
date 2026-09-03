/**
 * elementSizing — Figma's three sizing modes, translated to the CSS that
 * actually produces them in THIS element's parent.
 *
 * "Fill container" and "Hug contents" are not CSS values. They are intents,
 * and the declaration that expresses each one depends entirely on what the
 * parent is doing:
 *
 * | intent | parent flex, along its MAIN axis | parent flex, CROSS axis | block / grid |
 * |---|---|---|---|
 * | fill | `flex: 1 1 0%` | `align-self: stretch` | `width: 100%` |
 * | hug  | `flex: 0 0 auto` | `width: fit-content` | `width: fit-content` |
 *
 * Writing `width: 100%` on a flex row child is the single most common way to
 * get this wrong: it sets the flex BASE size, which the container then still
 * grows or shrinks, so the element ends up neither filling nor keeping the
 * width you asked for. Hence `parentLayout` is a required argument — a caller
 * that cannot read the parent has no business guessing.
 *
 * ## Why `fit-content` for the cross axis rather than `align-self: flex-start`
 *
 * A column flex container stretches its children's width by default, so the
 * obvious way to make one hug is to stop it stretching — `align-self:
 * flex-start`. That works, and it also silently changes the element's
 * ALIGNMENT, which is not what the user asked for by pressing "Hug".
 * `align-self: stretch` only applies when the cross size is `auto`, so an
 * explicit `fit-content` hugs without touching alignment at all. Same result,
 * no side effect.
 *
 * ## `null` means "clear this declaration"
 *
 * A patch says both what to write and what to remove: switching to Fill on a
 * main axis has to clear a leftover `width: 148px`, or the flex base size
 * fights the grow factor and the element does not fill. The panel's `onChange`
 * treats `undefined` as "clear", which is what `applySizingPatch` maps `null`
 * onto — spelled as `null` here so a patch is a plain, comparable object.
 */
import type { CSSPropertyBag } from '@core/page-tree'

export type SizingMode = 'fixed' | 'hug' | 'fill'
export type SizingAxis = 'width' | 'height'

/** The bits of the PARENT's resolved style that decide what fill/hug mean. */
export interface ParentLayout {
  /** The parent's computed `display`. */
  display: string
  /** The parent's computed `flex-direction`; ignored when it is not a flex container. */
  flexDirection: string
}

/** One property to write (`string`) or clear (`null`). */
export type SizingPatch = Partial<Record<keyof CSSPropertyBag, string | null>>

/** Keywords that size a box to its own content. */
const HUG_KEYWORDS = new Set(['auto', 'fit-content', 'max-content', 'min-content'])

function isFlexContainer(parent: ParentLayout | null): boolean {
  return parent?.display === 'flex' || parent?.display === 'inline-flex'
}

/**
 * Whether `axis` runs along the parent's MAIN axis — the only case where the
 * `flex` shorthand is the right tool.
 */
export function isMainAxis(axis: SizingAxis, parent: ParentLayout | null): boolean {
  if (!isFlexContainer(parent)) return false
  const column = parent!.flexDirection.startsWith('column')
  return axis === 'width' ? !column : column
}

/**
 * The declarations that put `axis` into `mode`.
 *
 * `fixedValue` is only read for `'fixed'`, and is the size to freeze — the
 * caller passes the element's measured px so pressing "Fixed" keeps it exactly
 * where it looks right now rather than collapsing it to nothing.
 */
export function sizingPatch(
  axis: SizingAxis,
  mode: SizingMode,
  parent: ParentLayout | null,
  fixedValue?: string,
): SizingPatch {
  const main = isMainAxis(axis, parent)
  const flexParent = isFlexContainer(parent)

  if (mode === 'fill') {
    if (main) return { flex: '1 1 0%', [axis]: null }
    if (flexParent) return { [axis]: null, alignSelf: 'stretch' }
    return { [axis]: '100%' }
  }

  if (mode === 'hug') {
    // Clearing `alignSelf` matters on the cross axis: a previous Fill wrote
    // `stretch`, and stretch would win back the moment anything else reset the
    // size to auto.
    if (main) return { flex: '0 0 auto', [axis]: 'auto' }
    if (flexParent) return { [axis]: 'fit-content', alignSelf: null }
    return { [axis]: 'fit-content' }
  }

  const value = fixedValue ?? 'auto'
  // On a main axis a bare width is only a BASIS — without `flex: 0 0 auto` the
  // container is still free to grow or shrink past it, and "Fixed" would not be.
  if (main) return { [axis]: value, flex: '0 0 auto' }
  if (flexParent) return { [axis]: value, alignSelf: null }
  return { [axis]: value }
}

/**
 * Which mode `axis` is currently in.
 *
 * Reads DECLARED values, never computed ones. That distinction is the whole
 * correctness of this function: `getComputedStyle` resolves every box to a
 * concrete pixel height, so a bag with computed values folded in makes every
 * element on the page look Fixed — including the auto-height ones that are the
 * most common thing on any page, and the ones a user is most likely to be
 * reaching for "Hug" to confirm.
 *
 * When the axis is undeclared the answer is CSS's own initial behaviour for a
 * child of THIS parent, which is a real answer and not "unknown": a flex item
 * is content-sized along the main axis and stretched across it, and a block
 * element fills its container's inline axis while hugging its content
 * vertically. Returning `null` there would leave the control blank for the
 * majority of elements, which reads as "this does nothing".
 */
export function currentSizingMode(
  axis: SizingAxis,
  declared: Record<string, unknown>,
  parent: ParentLayout | null,
): SizingMode {
  const raw = declared[axis]
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  const main = isMainAxis(axis, parent)

  if (main) {
    const grow = flexGrowOf(declared)
    if (grow !== null && grow > 0) return 'fill'
    if (isLength(value)) return 'fixed'
    // Undeclared, or `auto`/`fit-content`: a flex item with no grow factor is
    // sized by its content along the main axis.
    return 'hug'
  }

  if (value === '100%' || value === 'stretch') return 'fill'
  if (HUG_KEYWORDS.has(value) && value !== 'auto') return 'hug'
  if (isLength(value)) return 'fixed'
  if (declared['alignSelf'] === 'stretch') return 'fill'

  // Undeclared or `auto` — CSS's initial behaviour for this axis in this
  // parent. A flex item stretches across the cross axis; a block element
  // fills its container's inline axis and hugs its content vertically.
  if (isFlexContainer(parent)) return 'fill'
  return axis === 'width' ? 'fill' : 'hug'
}

/** The grow factor from a `flex` shorthand, or `null` when none is declared. */
function flexGrowOf(styles: Record<string, unknown>): number | null {
  const raw = styles['flex']
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed === 'none') return 0
  if (trimmed === 'auto' || trimmed === 'initial') return trimmed === 'auto' ? 1 : 0
  const first = Number.parseFloat(trimmed)
  return Number.isFinite(first) ? first : null
}

/** Whether a value is a concrete size rather than a keyword. */
function isLength(value: string): boolean {
  return /^-?\d*\.?\d+(px|rem|em|%|vw|vh|ch|ex|pt|cm|mm|in|pc)$/.test(value)
}
