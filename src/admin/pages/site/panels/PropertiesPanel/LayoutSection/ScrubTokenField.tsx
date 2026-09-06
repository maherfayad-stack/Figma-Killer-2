/**
 * ScrubTokenField — `TokenAwareInput` + Figma's "drag the letterform to
 * scrub" gesture (G4.9, docs/features/inspector-disclosure.md).
 *
 * `TokenAwareInput` has token autocomplete but no scrub gesture; `ScrubInput`
 * has the scrub gesture but no token autocomplete. This composes the two
 * instead of forking either: it wraps `TokenAwareInput` unmodified and adds
 * a draggable `prefix` glyph that reuses `ScrubInput`'s own pure drag math
 * (`applyScrubDelta` / `parseScrubValue` from `@ui/components/ScrubInput`) —
 * the exact same arithmetic, same modifier keys (Shift = ×10, Alt = ×0.1),
 * same "keywords and token expressions are not scrubbable" refusal.
 *
 * While dragging, the field's displayed value is a local override
 * (`dragValue`) rather than a prop straight from the store — committing on
 * every `pointermove` would spam an undo entry per pixel of movement.
 * `onPreview` still fires on every move (so the canvas tracks the drag live)
 * and the real commit (`onCommit`) fires once, on pointer-up, exactly like
 * `ScrubInput`.
 *
 * Only bare `<number><unit>` values are scrubbable — a token expression
 * (`var(--space-md)`) or a keyword make `parseScrubValue` return `null`, and
 * dragging becomes a no-op (typing still works), matching `ScrubInput`'s own
 * documented contract.
 */
import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import type { Token } from '@site/property-controls/tokenUtils'
import { applyScrubDelta, parseScrubValue } from '@ui/components/ScrubInput'
import styles from './ScrubTokenField.module.css'

interface ScrubTokenFieldProps {
  value: string | undefined
  placeholder?: string
  tokens: ReadonlyArray<Token>
  /** Draggable, `aria-hidden` glyph — a letterform ("H", "T") where that's unambiguous. */
  prefix: ReactNode
  'aria-label': string
  onCommit: (resolved: string | undefined) => void
  onPreview?: (resolved: string | undefined) => void
  onClearPreview?: () => void
  'data-testid'?: string
}

interface DragState {
  pointerId: number
  startX: number
  baseline: string
  moved: boolean
}

function scaleFor(e: { altKey: boolean; shiftKey: boolean }): number {
  return e.altKey ? 0.1 : e.shiftKey ? 10 : 1
}

export function ScrubTokenField({
  value,
  placeholder,
  tokens,
  prefix,
  'aria-label': ariaLabel,
  onCommit,
  onPreview,
  onClearPreview,
  'data-testid': dataTestId,
}: ScrubTokenFieldProps) {
  const [dragValue, setDragValue] = useState<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const inputRef = useRef<{ focus: () => void } | null>(null)

  function handlePointerDown(e: ReactPointerEvent<HTMLSpanElement>) {
    const baseline = value ?? ''
    // Same refusal as ScrubInput: a non-empty, non-numeric baseline (a token
    // expression, a keyword, `calc(...)`) can't be scrubbed — let the click
    // fall through to focusing the field for typing instead.
    if (parseScrubValue(baseline) === null && baseline.trim() !== '') return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, baseline, moved: false }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLSpanElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    if (dx !== 0) drag.moved = true
    const next = applyScrubDelta(drag.baseline, dx, { scale: scaleFor(e), fallbackUnit: 'px' })
    if (next !== null) {
      setDragValue(next)
      onPreview?.(next)
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLSpanElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
    dragRef.current = null
    if (!drag.moved) {
      // A click with no movement — focus the field for direct typing,
      // mirroring ScrubInput's own label click behaviour.
      setDragValue(null)
      inputRef.current?.focus()
      return
    }
    const finalValue = applyScrubDelta(drag.baseline, e.clientX - drag.startX, {
      scale: scaleFor(e),
      fallbackUnit: 'px',
    })
    setDragValue(null)
    onClearPreview?.()
    if (finalValue !== null && finalValue !== value) onCommit(finalValue)
  }

  return (
    <TokenAwareInput
      ref={inputRef}
      aria-label={ariaLabel}
      value={dragValue ?? value}
      placeholder={placeholder}
      tokens={tokens}
      data-testid={dataTestId}
      prefix={
        <span
          aria-hidden="true"
          className={styles.handle}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
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
