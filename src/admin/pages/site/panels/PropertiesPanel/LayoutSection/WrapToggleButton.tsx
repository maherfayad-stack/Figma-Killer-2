/**
 * WrapToggleButton — `flex-wrap`, collapsed to Figma's single toggle (F6
 * shows it top-right of the auto-layout block, not as a 3-way control).
 *
 * `FlexWrapControl`'s 3-segment `nowrap | wrap | wrap-reverse` picker is
 * replaced by ONE pressed/unpressed `Button` for the common `nowrap ↔ wrap`
 * choice. `wrap-reverse` isn't lost — it moves into the Layout settings ⚙
 * (`LayoutSettingsButton`, flex mode) as a resident `flexWrap` row that still
 * offers all three values via the same enum control every other advanced
 * property in that popover uses.
 *
 * Both wrapping values (`wrap` and `wrap-reverse`) show the toggle pressed —
 * it would be a lie to show "off" while `flex-wrap: wrap-reverse` is set —
 * and clicking it while pressed CLEARS the property rather than forcing it
 * back to `nowrap` explicitly, matching every other clear-on-active-click
 * control in this section.
 */
import { Button } from '@ui/components/Button'
import { TextWrapIcon } from 'pixel-art-icons/icons/text-wrap'

interface WrapToggleButtonProps {
  value: string | undefined
  onChange: (value: string) => void
  onClear: () => void
}

export function WrapToggleButton({ value, onChange, onClear }: WrapToggleButtonProps) {
  const isWrapping = value === 'wrap' || value === 'wrap-reverse'
  const tooltip =
    value === 'wrap-reverse'
      ? 'flex-wrap: wrap-reverse — click to clear'
      : isWrapping
        ? 'flex-wrap: wrap — click to clear'
        : 'Wrap'

  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      pressed={isWrapping}
      aria-label="Flex wrap"
      tooltip={tooltip}
      data-testid="css-layout-wrap-toggle"
      onClick={() => (isWrapping ? onClear() : onChange('wrap'))}
    >
      <TextWrapIcon size={14} aria-hidden="true" />
    </Button>
  )
}
