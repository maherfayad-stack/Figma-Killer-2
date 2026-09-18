/**
 * pinnedAxesLabel — turns a frame's per-frame `PreviewAxes` override
 * (`BoardFrame.axes`, `@core/studio-board`) into the short header badge text
 * `BoardFrameView` shows next to the frame title.
 *
 * `frame.axes` is a `Partial<PreviewAxes>` — a "duplicate as RTL" sibling
 * carries only `{ direction: 'rtl' }`, never all three keys. This formatter
 * emits ONLY the keys actually present, in a fixed, stable order
 * (direction, colorScheme, locale) so a one-key override reads as one axis,
 * never as "the other two got silently defaulted to something".
 *
 * Value formatting matches the toolbar's own vocabulary
 * (`PreviewAxesControls.tsx`): `RTL`/`LTR`, `Dark`/`Light`, and a locale key
 * upper-cased (the same transform its `Select`'s own `options` list uses).
 */
import type { PreviewAxes } from '@core/studio-board'

const AXIS_ORDER: ReadonlyArray<keyof PreviewAxes> = ['direction', 'colorScheme', 'locale']

function formatAxisValue(key: keyof PreviewAxes, axes: Partial<PreviewAxes>): string | null {
  switch (key) {
    case 'direction':
      if (axes.direction === undefined) return null
      return axes.direction === 'rtl' ? 'RTL' : 'LTR'
    case 'colorScheme':
      if (axes.colorScheme === undefined) return null
      return axes.colorScheme === 'dark' ? 'Dark' : 'Light'
    case 'locale':
      return axes.locale === undefined ? null : axes.locale.toUpperCase()
    default:
      return null
  }
}

/**
 * Returns `null` when `axes` has no keys set (nothing to badge), otherwise
 * the `' · '`-joined labels for exactly the keys present.
 */
export function describePinnedAxes(axes: Partial<PreviewAxes> | undefined): string | null {
  if (!axes) return null
  const parts = AXIS_ORDER.map((key) => formatAxisValue(key, axes)).filter((v): v is string => v !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}
