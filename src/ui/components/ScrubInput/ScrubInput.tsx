/**
 * ScrubInput — Figma's signature inspector interaction: drag the field's
 * label to change its number, instead of only being able to type into it.
 *
 * Composed of:
 *   - a draggable `label` (e.g. `"W"`) — pointerdown-drag scrubs the value;
 *     a plain click (no movement) focuses the text field for direct typing;
 *   - the text field itself — keyboard arrow keys step the value (±`step`,
 *     ±`shiftStep` with Shift, ×0.1 with Alt/Option — same modifier
 *     vocabulary as the drag gesture) and typing commits on blur/Enter/Tab;
 *   - `MixedValue` support — pass `MIXED` as `value` for a multi-selection
 *     whose values disagree; the field shows an empty "Mixed" placeholder,
 *     dragging is disabled (there's no single baseline to drag from), and
 *     typing replaces the value on every selected item (the caller's
 *     `onChange` decides what "every" means).
 *
 * `onPreview` during a drag is rAF-coalesced, not fired per `pointermove`. A
 * drag gesture can deliver `pointermove` well over 60Hz (a high-poll-rate
 * mouse/trackpad), and each call is wired all the way to a live editor-store
 * write (`setPreviewClassStyles`) that every mounted breakpoint iframe's
 * `ClassStyleInjector` re-derives style CSS from — firing it faster than the
 * screen can paint does strictly more work for zero additional visible
 * smoothness. `schedulePreview` (below) keeps only the latest in-flight
 * value and flushes it on the next animation frame, so a fast drag collapses
 * to at most one store write per frame. The field's own `draft` state (what
 * the label/input show) still updates synchronously on every `pointermove` —
 * only the external preview channel is throttled, so the control itself
 * never looks laggy. The final value on release is never coalesced:
 * `handleLabelPointerUp` cancels any pending preview and commits through
 * `onChange` directly, so a fast release can never be dropped behind a stale
 * scheduled frame.
 *
 * Value contract: a CSS-length-ish string (`"120px"`, `"auto"`, `"50%"`),
 * matching what the rest of the CSS property editors already pass around
 * (`ClassPropertyRow`, `TokenAwareInput`). Only bare `<number><unit>`
 * strings are scrubbable/nudgeable — `SCRUB_KEYWORDS` (`auto`/`fill`/`hug`)
 * and anything else (`calc()`, `var()`, empty) render and can still be
 * *typed*, but dragging/arrow-keying them is a no-op: there's no numeric
 * baseline to scrub from, and silently coercing a keyword to `0px` would be
 * exactly the kind of lying control this codebase's controls avoid.
 */
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { cn } from '@ui/cn'
import { MIXED, isMixed, type Mixed } from '../MixedValue'
import { applyKeyboardStep, applyScrubDelta, isScrubKeyword, parseScrubValue } from './scrubMath'
import styles from './ScrubInput.module.css'

export { MIXED }

type FieldSize = 'xs' | 'sm' | 'md'

export interface ScrubInputProps {
  /** Current value, or `MIXED` when a multi-selection's values disagree. */
  value: string | Mixed | undefined
  /**
   * Fired with the new value on every committed change: a completed drag
   * step, a keyboard nudge, or a text commit (blur / Enter / Tab). Drag and
   * keyboard nudges fire on every intermediate step (not just on release),
   * matching Figma's live-updating canvas.
   */
  onChange: (next: string) => void
  /** Optional as-you-type / as-you-drag preview channel, cleared via `onClearPreview`. */
  onPreview?: (next: string) => void
  onClearPreview?: () => void
  /**
   * The in-field mark. Drag it to scrub.
   *
   * A letterform where one is unambiguous (`W`, `H`, `X`), a glyph where it
   * isn't: "Min W" and "Max H" spelled out cost more of a 24px field than
   * the number they sit beside, which is why Figma draws them. Either way
   * the field's own `aria-label` is the accessible name — a glyph passed
   * here is decoration and must be `aria-hidden`.
   */
  label: ReactNode
  'aria-label': string
  /** Unit assigned when scrubbing/nudging starts from an empty field. Default `'px'`. */
  unit?: string
  /** Magnitude change per plain arrow-key press or per pixel of drag. Default 1. */
  step?: number
  /** Magnitude change per Shift+arrow-key press, and the drag speed multiplier while Shift is held. Default 10. */
  shiftStep?: number
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
  fieldSize?: FieldSize
  className?: string
  'data-testid'?: string
}

export function ScrubInput({
  value,
  onChange,
  onPreview,
  onClearPreview,
  label,
  'aria-label': ariaLabel,
  unit = 'px',
  step = 1,
  shiftStep = 10,
  min,
  max,
  placeholder,
  disabled = false,
  fieldSize = 'sm',
  className,
  'data-testid': dataTestId,
}: ScrubInputProps) {
  const mixed = isMixed(value)
  const display = mixed ? '' : (value ?? '')

  const [draft, setDraft] = useState(display)
  const [isEditing, setIsEditing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; baseline: string; moved: boolean } | null>(null)

  // Sync external value → draft when not actively editing/dragging (React 19
  // "adjust state during render" idiom — same pattern as TokenAwareInput).
  const [lastExternal, setLastExternal] = useState(display)
  if (!isEditing && !isDragging && display !== lastExternal) {
    setLastExternal(display)
    setDraft(display)
  }

  // rAF-coalescing for the drag preview channel — see the file docblock.
  // `onPreviewRef` is kept fresh every render (not memoized) so the
  // scheduled frame always calls the LATEST `onPreview`, never one captured
  // in a stale closure from whichever `pointermove` happened to start it.
  // Refs must not be written during render (React reference semantics), so
  // the sync runs in an effect with no dependency array — it re-runs after
  // every commit, deliberately.
  const onPreviewRef = useRef(onPreview)
  useEffect(() => {
    onPreviewRef.current = onPreview
  })
  const previewRafIdRef = useRef<number | null>(null)
  const pendingPreviewValueRef = useRef<string | null>(null)

  function schedulePreview(next: string) {
    pendingPreviewValueRef.current = next
    if (previewRafIdRef.current !== null) return
    previewRafIdRef.current = requestAnimationFrame(() => {
      previewRafIdRef.current = null
      const value = pendingPreviewValueRef.current
      pendingPreviewValueRef.current = null
      if (value !== null) onPreviewRef.current?.(value)
    })
  }

  function cancelScheduledPreview() {
    if (previewRafIdRef.current !== null) {
      cancelAnimationFrame(previewRafIdRef.current)
      previewRafIdRef.current = null
    }
    pendingPreviewValueRef.current = null
  }

  // A drag abandoned by unmount (e.g. the selection changes mid-scrub, or the
  // Properties panel closes) must not fire a scheduled preview against a
  // caller that's already gone. Written against the refs directly (not the
  // `cancelScheduledPreview` closure above) so this effect has no non-ref
  // dependency and never needs to re-run.
  useEffect(() => {
    return () => {
      if (previewRafIdRef.current !== null) cancelAnimationFrame(previewRafIdRef.current)
    }
  }, [])

  function commit(raw: string) {
    setIsEditing(false)
    cancelScheduledPreview()
    onClearPreview?.()
    if (raw !== display) onChange(raw)
  }

  function handleLabelPointerDown(e: ReactPointerEvent<HTMLSpanElement>) {
    if (disabled || mixed) return
    const baseline = isEditing ? draft : display
    if (parseScrubValue(baseline) === null && baseline.trim() !== '') return
    e.preventDefault()
    // Feature-checked: pointer capture isn't universal (older touch browsers).
    // Dragging still works without it — capture just keeps the gesture live
    // when the pointer strays off the (few-pixel-tall) label.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, baseline, moved: false }
    setIsDragging(true)
  }

  function handleLabelPointerMove(e: ReactPointerEvent<HTMLSpanElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const totalDx = e.clientX - drag.startX
    if (totalDx !== 0) drag.moved = true
    const scale = e.altKey ? 0.1 : e.shiftKey ? shiftStep : step
    const next = applyScrubDelta(drag.baseline, totalDx, { scale, min, max, fallbackUnit: unit })
    if (next !== null) {
      setDraft(next)
      schedulePreview(next)
    }
  }

  function handleLabelPointerUp(e: ReactPointerEvent<HTMLSpanElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
    dragRef.current = null
    setIsDragging(false)
    // The final value on release always commits via `onChange` below, computed
    // fresh from this exact pointerup's `clientX` — cancel rather than flush
    // any still-pending coalesced preview so a stale mid-gesture value can
    // never land a frame after the real final value already did.
    cancelScheduledPreview()
    if (!drag.moved) {
      // A click with no movement — treat as "focus the field to type".
      inputRef.current?.focus()
      inputRef.current?.select()
      return
    }
    onClearPreview?.()
    const finalValue = applyScrubDelta(drag.baseline, e.clientX - drag.startX, {
      scale: e.altKey ? 0.1 : e.shiftKey ? shiftStep : step,
      min,
      max,
      fallbackUnit: unit,
    })
    if (finalValue !== null && finalValue !== display) onChange(finalValue)
  }

  function handleInputFocus() {
    setIsEditing(true)
  }

  function handleInputBlur(e: FocusEvent<HTMLInputElement>) {
    commit(e.target.value)
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(display)
      setIsEditing(false)
      onClearPreview?.()
      e.currentTarget.blur()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const base = draft.trim() === '' ? (placeholder ?? `0${unit}`) : draft
      const parsed = parseScrubValue(base)
      if (parsed === null) return // keyword / non-numeric — let the caret move instead
      e.preventDefault()
      const direction = e.key === 'ArrowUp' ? 1 : -1
      const next = applyKeyboardStep(base, direction, {
        step: e.altKey ? 0.1 : step,
        shiftStep,
        shift: e.shiftKey,
        min,
        max,
        fallbackUnit: unit,
      })
      if (next !== null) {
        setDraft(next)
        onChange(next)
      }
    }
  }

  const showingKeyword = !mixed && isScrubKeyword(draft)

  return (
    <div
      className={cn(styles.wrapper, styles[`size-${fieldSize}`], disabled && styles.disabled, className)}
      data-testid={dataTestId}
      data-dragging={isDragging ? 'true' : undefined}
      data-state={mixed ? 'mixed' : undefined}
    >
      <span
        className={cn(styles.label, disabled && styles.labelDisabled)}
        onPointerDown={handleLabelPointerDown}
        onPointerMove={handleLabelPointerMove}
        onPointerUp={handleLabelPointerUp}
        data-testid={dataTestId ? `${dataTestId}-label` : undefined}
      >
        {label}
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        className={cn(styles.input, showingKeyword && styles.keyword)}
        value={draft}
        placeholder={mixed ? 'Mixed' : placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        onFocus={handleInputFocus}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          if (next.trim() !== '') onPreview?.(next)
        }}
        onBlur={handleInputBlur}
        onKeyDown={handleKeyDown}
        data-testid={dataTestId ? `${dataTestId}-field` : undefined}
      />
    </div>
  )
}
