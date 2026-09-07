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
 * The drag gesture itself is NOT implemented here: it is `useScrubDrag`
 * (`useScrubDrag.ts`), the single scrub engine every numeric field in the
 * editor shares — including the token-aware ones, which cannot render this
 * component but need the identical gesture. That module's doc owns the
 * gesture's contract (the keyword refusal, the 1/10/0.1 ladder, min/max, the
 * rAF-coalesced preview channel, the fresh-from-`pointerup` final value).
 * This file owns everything a scrub field does when you are TYPING in it.
 *
 * Value contract: a CSS-length-ish string (`"120px"`, `"auto"`, `"50%"`),
 * matching what the rest of the CSS property editors already pass around
 * (`ClassPropertyRow`, `TokenAwareInput`). Only bare `<number><unit>`
 * strings are scrubbable/nudgeable — `SCRUB_KEYWORDS` (`auto`/`fill`/`hug`)
 * and anything else (`calc()`, `var()`, empty) render and can still be
 * *typed*, but dragging/arrow-keying them is a no-op: there's no numeric
 * baseline to scrub from, and silently coercing a keyword to `0px` would be
 * exactly the kind of lying control this codebase's controls avoid.
 *
 * A TYPED commit goes through `resolveCommitValue` (`scrubMath.ts`), which
 * gives a bare number this field's `unit` and evaluates arithmetic
 * (`100/2`, `100+8`). Without it, typing `50` into Width emitted the invalid
 * declaration `width: 50` — the field's whole job is producing a value CSS
 * accepts, and the commit path is where that is decided.
 *
 * ENTER COMMITS AND KEEPS FOCUS, Figma's behaviour: the value lands, the
 * text is re-selected so the next keystroke replaces it, and the caret never
 * leaves the field. Blur commits too (so click-away is not a discard) and
 * Escape reverts. Nothing about a commit implies losing focus.
 */
import {
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '@ui/cn'
import { MIXED, isMixed, type Mixed } from '../MixedValue'
import { applyKeyboardStep, isScrubKeyword, parseScrubValue, resolveCommitValue } from './scrubMath'
import { useScrubDrag } from './useScrubDrag'
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
  /**
   * The field's unit: assigned when scrubbing/nudging starts from an empty
   * field, AND appended to a typed bare number on commit. Default `'px'`.
   * Pass `''` for a genuinely unitless field (a frame's pixel count, a
   * ratio) — a bare number then stays bare.
   */
  unit?: string
  /** Magnitude change per plain arrow-key press or per pixel of drag. Default 1 — the one nudge model, see `numericNudge.ts`. */
  step?: number
  /** Magnitude change per Shift+arrow-key press, and the drag speed multiplier while Shift is held. Default 10. */
  shiftStep?: number
  min?: number
  max?: number
  placeholder?: string
  /**
   * The displayed `value` is what the element actually renders, not something
   * the field's own target declares — the panel's prefill state (see
   * `styleFieldDisplay.ts` in the Properties panel). Presentation only: the
   * field is fully live, and committing over the value writes it for real.
   * Renders one text tone down so "shown" is never mistaken for "set here".
   */
  inherited?: boolean
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
  inherited = false,
  disabled = false,
  fieldSize = 'sm',
  className,
  'data-testid': dataTestId,
}: ScrubInputProps) {
  const mixed = isMixed(value)
  const display = mixed ? '' : (value ?? '')

  const [draft, setDraft] = useState(display)
  const [isEditing, setIsEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Set by Escape so the blur it triggers discards instead of committing — see `handleInputBlur`. */
  const revertingRef = useRef(false)

  // The one scrub engine. `MIXED` disables it outright: a multi-selection whose
  // values disagree has no single baseline to drag from.
  const scrub = useScrubDrag({
    baseline: isEditing ? draft : display,
    disabled: disabled || mixed,
    unit,
    step,
    shiftStep,
    min,
    max,
    onPreview,
    onClearPreview,
    onCommit: (next) => {
      if (next !== display) onChange(next)
    },
    onLabelClick: () => {
      // A press with no movement — treat as "focus the field to type".
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  })

  // Mirror the live drag value into the draft (React 19 "adjust state during
  // render" idiom, converging in one extra render pass). The field shows
  // `draft` and nothing else, so a gesture that ends between two external
  // values can never flash the pre-drag number back at the user.
  if (scrub.dragValue !== null && scrub.dragValue !== draft) setDraft(scrub.dragValue)

  // Sync external value → draft when not actively editing/dragging (same
  // idiom, same pattern as TokenAwareInput).
  const [lastExternal, setLastExternal] = useState(display)
  if (!isEditing && !scrub.isDragging && display !== lastExternal) {
    setLastExternal(display)
    setDraft(display)
  }

  /**
   * Commit a typed value. Coerces first (`resolveCommitValue`), so what the
   * field shows after a commit is exactly what was written to the stylesheet
   * — a typed `50` reads back as `50px`, not as the invalid `50` it used to
   * emit. Focus is NOT touched here: blur and Enter both route through this,
   * and only blur ends the editing session.
   */
  function commit(raw: string): string {
    onClearPreview?.()
    const next = resolveCommitValue(raw, unit)
    if (next !== draft) setDraft(next)
    if (next !== display) onChange(next)
    return next
  }

  function handleInputFocus() {
    setIsEditing(true)
  }

  function handleInputBlur(e: FocusEvent<HTMLInputElement>) {
    setIsEditing(false)
    // Escape reverts and then blurs. The blur fires synchronously, BEFORE
    // React has re-rendered the reverted draft, so `e.target.value` here is
    // still the abandoned text — committing it would make Escape write the
    // very value it was pressed to discard.
    if (revertingRef.current) {
      revertingRef.current = false
      setDraft(display)
      return
    }
    commit(e.target.value)
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const input = e.currentTarget
      commit(input.value)
      // Figma: Enter commits without leaving the field, and re-selects so the
      // next keystroke replaces the value. Selection runs after the commit's
      // re-render so it targets the coerced text, not the pre-commit draft.
      requestAnimationFrame(() => input.select())
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      revertingRef.current = true
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
      // One nudge model, `numericNudge.ts`'s: plain 1, Shift 10, Alt 0.1 —
      // and Alt wins over Shift, because the fine step is the more specific
      // request. `step`/`shiftStep` stay props only so a caller can widen the
      // model for a value space where 1 is meaningless, not to re-decide it.
      const next = applyKeyboardStep(base, direction, {
        step: e.altKey ? 0.1 : step,
        shiftStep,
        shift: e.shiftKey && !e.altKey,
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
      data-dragging={scrub.isDragging ? 'true' : undefined}
      data-state={mixed ? 'mixed' : undefined}
      data-inherited={inherited ? 'true' : undefined}
    >
      <span
        className={cn(styles.label, disabled && styles.labelDisabled)}
        {...scrub.handleProps}
        data-testid={dataTestId ? `${dataTestId}-label` : undefined}
      >
        {label}
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        className={cn(styles.input, showingKeyword && styles.keyword, inherited && styles.inherited)}
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
