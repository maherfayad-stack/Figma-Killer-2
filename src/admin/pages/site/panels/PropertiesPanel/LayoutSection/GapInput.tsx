/**
 * GapInput — token-aware text input for `gap` (writes the unified shorthand).
 *
 * Promotes the `gap` row out of the fallback list and into the flex / grid
 * blocks where it belongs (right below Justify). Backed by `ScrubTokenField`
 * so users get framework spacing variable autocomplete as they type — same
 * vocabulary as the SpacingBoxControl side inputs — AND the drag gesture every
 * other length in the panel has.
 *
 * The two-panels-with-a-channel mark rides inside the field, so the row costs
 * one line rather than a line plus a caption, and doubles as the scrub handle.
 * `aria-label` still says "Gap". `min: 0` because a negative gap is not a CSS
 * value — the drag stops at zero rather than emitting one.
 */

import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { GapIcon } from '@ui/components/InspectorIcons'
import { LabeledControl } from './LabeledControl'
import { ScrubTokenField } from './ScrubTokenField'

interface GapInputProps {
  value: string | undefined
  isSet: boolean
  /** W8-3 — the selection disagrees on `gap`; the field reads "Mixed". */
  mixed?: boolean
  onChange: (value: string | undefined) => void
  /** Hover / as-you-type preview of the resolved gap value (token-aware). */
  onPreview?: (value: string | undefined) => void
  onClearPreview?: () => void
}

export function GapInput({ value, isSet, mixed, onChange, onPreview, onClearPreview }: GapInputProps) {
  const tokens = useSpacingTokens()
  return (
    <LabeledControl isSet={isSet}>
      <ScrubTokenField
        aria-label="Gap"
        value={value}
        placeholder="0px"
        mixed={mixed}
        prefix={<GapIcon size={13} aria-hidden="true" />}
        tokens={tokens}
        min={0}
        onCommit={onChange}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
        data-testid="css-gap-input"
      />
    </LabeledControl>
  )
}
