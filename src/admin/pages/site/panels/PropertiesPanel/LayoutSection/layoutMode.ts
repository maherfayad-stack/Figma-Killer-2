/**
 * layoutMode — the (display, flex-direction) ↔ layout-mode mapping behind
 * `LayoutModeRow`. Pure logic lives in its own module (not the component
 * file) per this codebase's convention (`cssControlTypes.ts`,
 * `styleValueUtils.ts`) and so it stays fast-refresh safe.
 *
 * See `LayoutModeRow.tsx`'s doc for the defect this fixes: `display` is a
 * CSS *mechanism* (a ten-value keyword); Figma's F3/F4/F6/F7 expose layout
 * *intent* — four modes, always the same four buttons. A layout mode is a
 * `(display, flex-direction)` PAIR, not a raw `display` value.
 */

import type { CSSPropertyBag } from '@core/page-tree'

export type LayoutMode = 'none' | 'vertical' | 'horizontal' | 'grid'

/**
 * `display` values the four mode buttons can represent directly, including
 * unset (treated as "no auto layout" — the common plain-block case). Every
 * other keyword is unrepresentable: `resolveLayoutMode` still classifies it
 * (it is total), but callers MUST gate on this set before using that
 * classification to highlight a segment, or e.g. `display: inline-block`
 * would silently read as "no auto layout" — a lie about what's actually set.
 */
const REPRESENTABLE_DISPLAYS: ReadonlySet<string> = new Set(['block', 'flex', 'inline-flex', 'grid'])

export function isLayoutModeRepresentable(display: string | undefined): boolean {
  return display == null || display === '' || REPRESENTABLE_DISPLAYS.has(display)
}

/**
 * Classifies `(display, flexDirection)` into one of the four Figma-style
 * layout modes. Pure and total. `row-reverse`/`column-reverse` map to
 * horizontal/vertical exactly like their non-reversed siblings — the reverse
 * flag lives in the ⚙ (`FlexDirectionControl`), not a fifth mode button.
 * `inline-flex` reads the same as `flex`: what the four buttons distinguish
 * is layout mechanism, not inline vs. block formatting context.
 */
export function resolveLayoutMode(
  display: string | undefined,
  flexDirection: string | undefined,
): LayoutMode {
  switch (display) {
    case 'flex':
    case 'inline-flex':
      return flexDirection === 'column' || flexDirection === 'column-reverse' ? 'vertical' : 'horizontal'
    case 'grid':
      return 'grid'
    default:
      return 'none'
  }
}

/**
 * Container properties whose visual controls only render while the layout
 * mode is flex or grid. Switching TO 'none' clears these alongside `display`
 * in one step, so the section never reports a phantom "N set" badge for
 * properties no control can reach once the mode buttons hide their block.
 *
 * `alignSelf`/`justifySelf`/`flex`/`gridColumn`/`gridRow` are DELIBERATELY
 * EXCLUDED and must stay excluded — see `LayoutSection.tsx`'s doc: those are
 * item-level properties governed by the PARENT's display, not this
 * element's own, so clearing THIS element's mode must never touch them.
 */
export const DISPLAY_DEPENDENT_PROPS: ReadonlyArray<keyof CSSPropertyBag> = [
  'flexDirection',
  'flexWrap',
  'alignItems',
  'justifyContent',
  'justifyItems',
  'gap',
  'rowGap',
  'columnGap',
  'gridTemplateColumns',
  'gridTemplateRows',
]

export interface LayoutModePatch {
  /** Properties to write for this mode. Empty for 'none'. */
  set: Readonly<Partial<Pick<CSSPropertyBag, 'display' | 'flexDirection'>>>
  /** Properties to clear for this mode. Only 'none' clears anything. */
  clear: ReadonlyArray<keyof CSSPropertyBag>
}

/**
 * Mode → CSS. Per-mode behaviour, matching the reference table exactly:
 *
 *   none       → clear `display` (and its flex/grid deps, in one step)
 *   vertical   → display: flex;  flex-direction: column
 *   horizontal → display: flex;  flex-direction: row
 *   grid       → display: grid
 *
 * Switching directly between vertical/horizontal/grid intentionally does
 * NOT prune the other mode's leftover properties (e.g. grid → vertical
 * leaves `gridTemplateColumns` stored) — that mirrors the prior switcher's
 * behaviour (its primary segments never pruned either) and keeps this patch
 * focused on the one case the bug report calls out.
 */
export function layoutModePatch(mode: LayoutMode): LayoutModePatch {
  switch (mode) {
    case 'none':
      return { set: {}, clear: ['display', ...DISPLAY_DEPENDENT_PROPS] }
    case 'vertical':
      return { set: { display: 'flex', flexDirection: 'column' }, clear: [] }
    case 'horizontal':
      return { set: { display: 'flex', flexDirection: 'row' }, clear: [] }
    case 'grid':
      return { set: { display: 'grid' }, clear: [] }
  }
}
