import { formatColor, parseCssColor } from '@ui/components/ColorPickerPopover'

/**
 * The text a colour field SHOWS for a stored or computed value. The frame
 * reports computed colours as `rgb(146, 159, 163)` / `rgba(0, 0, 0, 0.5)`;
 * Figma shows hex, so a functional `rgb()` / `hsl()` is shown as `#rrggbb`
 * (`#rrggbbaa` when translucent - the alpha stays in the text, and the `%`
 * field beside it edits it). Hex, named colours, `var(--token)` references
 * (a token is already shown by name) and anything unparsable are shown exactly
 * as written: the field must never rewrite what the author typed.
 */
export function colorDisplayText(value: string): string {
  const parsed = parseCssColor(value)
  if (parsed === null || parsed.model === 'hex') return value
  return formatColor(parsed.rgba, 'hex')
}
