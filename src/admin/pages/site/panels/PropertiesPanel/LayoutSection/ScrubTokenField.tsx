/**
 * ScrubTokenField — `TokenAwareInput` wearing the scrub gesture
 * (G4.9, docs/features/inspector-disclosure.md §5).
 *
 * `TokenAwareInput` has token autocomplete but no scrub gesture; `ScrubInput`
 * has the scrub gesture but no token autocomplete. A component that RENDERS
 * `ScrubInput` therefore cannot be token-aware, which is why this composes at
 * the level the two field kinds actually share: `useScrubDrag`, the single
 * scrub engine (`@ui/components/ScrubInput`). This file is now the wiring and
 * nothing else — the drag state machine, the keyword refusal, the 1/10/0.1
 * ladder, min/max clamping and the rAF-coalesced preview channel all live in
 * that hook, which `ScrubInput` calls too.
 *
 * It used to carry its own copy of the gesture, and the copy had drifted: no
 * rAF coalescing (so a fast padding drag fired one editor-store write per
 * `pointermove` instead of one per frame), no `min`/`max`, and a hardcoded
 * `altKey ? 0.1 : shiftKey ? 10 : 1` ladder sitting beside the keyboard one.
 * All three are gone by deletion, not by being fixed twice.
 *
 * Only bare `<number><unit>` values are scrubbable — a token expression
 * (`var(--space-md)`) or a keyword makes the gesture a no-op (typing still
 * works), matching the engine's documented contract.
 */
import { useRef, type ReactNode } from 'react'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import type { Token } from '@site/property-controls/tokenUtils'
import { useScrubDrag } from '@ui/components/ScrubInput'
import styles from './ScrubTokenField.module.css'

interface ScrubTokenFieldProps {
  value: string | undefined
  placeholder?: string
  tokens: ReadonlyArray<Token>
  /** Draggable, `aria-hidden` mark — a letterform ("H", "T") or a glyph. */
  prefix: ReactNode
  'aria-label': string
  /**
   * Unit assigned when a drag starts from an empty field, mirroring
   * `ScrubInput`'s prop of the same name. Default `'px'` — every current
   * caller is a length.
   */
  unit?: string
  min?: number
  max?: number
  disabled?: boolean
  className?: string
  onCommit: (resolved: string | undefined) => void
  onPreview?: (resolved: string | undefined) => void
  onClearPreview?: () => void
  'data-testid'?: string
}

export function ScrubTokenField({
  value,
  placeholder,
  tokens,
  prefix,
  'aria-label': ariaLabel,
  unit = 'px',
  min,
  max,
  disabled,
  className,
  onCommit,
  onPreview,
  onClearPreview,
  'data-testid': dataTestId,
}: ScrubTokenFieldProps) {
  const inputRef = useRef<{ focus: () => void } | null>(null)

  const scrub = useScrubDrag({
    baseline: value ?? '',
    unit,
    min,
    max,
    disabled,
    onCommit: (next) => {
      if (next !== value) onCommit(next)
    },
    onPreview,
    onClearPreview,
    // A click with no movement — focus the field for direct typing, mirroring
    // `ScrubInput`'s own label-click behaviour.
    onLabelClick: () => inputRef.current?.focus(),
  })

  return (
    <TokenAwareInput
      ref={inputRef}
      aria-label={ariaLabel}
      value={scrub.dragValue ?? value}
      placeholder={placeholder}
      tokens={tokens}
      disabled={disabled}
      className={className}
      data-testid={dataTestId}
      prefix={
        <span
          aria-hidden="true"
          className={styles.handle}
          data-dragging={scrub.isDragging ? 'true' : undefined}
          data-testid={dataTestId ? `${dataTestId}-handle` : undefined}
          {...scrub.handleProps}
        >
          {prefix}
        </span>
      }
      onCommit={onCommit}
      onPreview={onPreview}
      onClearPreview={onClearPreview}
    />
  )
}
