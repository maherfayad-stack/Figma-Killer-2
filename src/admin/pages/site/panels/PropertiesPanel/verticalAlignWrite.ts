/**
 * verticalAlignWrite — the honest single-CSS-write check behind the
 * Typography section's vertical-align icon group
 * (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md G9.2 / §7 / §8.4).
 *
 * Figma's "vertical align" has no CSS equivalent for arbitrary text — there
 * is no `vertical-align: middle` for a block of wrapped copy. The nearest
 * honest mapping is `align-items` on the text node's OWN box: a lone text
 * run inside `display: flex` renders as one anonymous flex item, so
 * `align-items` really does move it up/down — but ONLY when the node is
 * itself a flex container whose cross axis is vertical (`flex-direction:
 * row`, the default; under `column` the axes swap and `align-items` would
 * move the text horizontally instead).
 *
 * When neither holds, the control renders DISABLED with the reason below as
 * its tooltip, rather than disappearing — the asymmetry with Figma is real
 * and hiding it is the lie this repo's second invariant forbids.
 *
 * `alignItems` is the exact same property `LayoutSection`'s own alignment
 * control writes for a flex CONTAINER's children. There is only one
 * property here; this is a second, convenience surface onto it, aimed at
 * the (very common) case of a text node made `display: flex` purely to
 * center its own text vertically.
 *
 * A plain module, not a component, for the same reason `resolveAlignWrite.ts`
 * is: `react-refresh/only-export-components` wants a component file to
 * export components only, and there is no JSX here.
 */

export type VerticalAlign = 'top' | 'middle' | 'bottom'

export type VerticalAlignAvailability =
  | { available: true }
  | { available: false; reason: string }

const VERTICAL_ALIGN_VALUES: Readonly<Record<VerticalAlign, string>> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
}

/** The `align-items` value one vertical-align edge writes. */
export function verticalAlignEdgeValue(edge: VerticalAlign): string {
  return VERTICAL_ALIGN_VALUES[edge]
}

/**
 * Whether this element's own `align-items` can honestly stand in for
 * "vertical align" right now. Independent of which edge the user is about
 * to click — all three share one availability check, so the control
 * disables as a group rather than button-by-button (unlike `AlignBar`,
 * which needs a per-edge reason because its three axes genuinely differ).
 */
export function resolveVerticalAlignAvailability(
  currentStyles: Record<string, unknown>,
): VerticalAlignAvailability {
  const display = typeof currentStyles.display === 'string' ? currentStyles.display : undefined
  if (display !== 'flex' && display !== 'inline-flex') {
    return {
      available: false,
      reason:
        "Vertical align needs this element's own display set to flex — there is no other honest CSS mapping for vertical text alignment.",
    }
  }
  const flexDirection =
    typeof currentStyles.flexDirection === 'string' ? currentStyles.flexDirection : 'row'
  if (flexDirection.startsWith('column')) {
    return {
      available: false,
      reason:
        "This element's flex-direction is column, so align-items moves content horizontally here, not vertically.",
    }
  }
  return { available: true }
}

/**
 * Reverse-maps a stored `alignItems` value back to the edge it represents,
 * or `undefined` when unset or not one of the three this control round-trips
 * (e.g. `stretch`/`baseline`, which have no vertical-align equivalent).
 */
export function verticalAlignFromAlignItems(value: unknown): VerticalAlign | undefined {
  if (typeof value !== 'string') return undefined
  if (value === 'flex-start' || value === 'start') return 'top'
  if (value === 'center') return 'middle'
  if (value === 'flex-end' || value === 'end') return 'bottom'
  return undefined
}
