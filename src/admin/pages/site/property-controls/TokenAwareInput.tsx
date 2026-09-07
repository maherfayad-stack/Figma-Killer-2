/**
 * TokenAwareInput — a single text input + autocomplete dropdown that
 * suggests framework variables (spacing scale, typography scale, …).
 *
 * Visual / behavioural model is identical to the SpacingBoxControl side
 * input, just decoupled from the box-model UI:
 *
 *   - User types `m` → menu shows tokens whose step starts with `m`.
 *   - Picking `m` (Enter / click) commits `var(--space-m)` (or whichever
 *     `valueExpr` the matching token carries).
 *   - Typing a direct CSS value (`12px`, `auto`, `calc(...)`) hides the
 *     menu so the value can be committed without the dropdown stealing
 *     outside-clicks.
 *   - As-you-type live preview through `onPreview` / `onClearPreview`.
 *   - Stored `var(--space-m)` round-trips back to the short `m` display.
 *
 * The component is presentation-only — token sourcing (spacing vs
 * typography vs sizing scale) is the caller's choice via the `tokens`
 * prop, populated by hooks from `tokenUtils.ts`.
 */

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@ui/components/Input'
import { Tooltip } from '@ui/components/Tooltip'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import {
  LENGTH_VARIABLE_KINDS,
  parseVarBinding,
  useVariableAffordance,
  type VariableKind,
} from '@ui/components/VariableField'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { cn } from '@ui/cn'
import {
  type Token,
  resolveTokenValue,
  displayTokenValue,
  looksLikeDirectValue,
  isLivePreviewable,
} from './tokenUtils'
import { handleNudgeKeydown, parseNudgeableValue } from './numericNudge'
import styles from './TokenAwareInput.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface TokenAwareInputHandle {
  /** Focus the underlying input. */
  focus(): void
}

interface TokenAwareInputProps {
  id?: string
  /** Current resolved CSS value (e.g. `var(--space-md)`, `12px`, `auto`). */
  value: string | undefined
  /**
   * True when the field is driven by a multi-selection whose values disagree.
   * The field shows the shared "Mixed" placeholder over an empty draft rather
   * than one member's value; committing (Enter / blur / a token pick) writes
   * the typed value to the whole selection through `onCommit`.
   */
  mixed?: boolean
  /** Placeholder shown when no value is set. Token-display is applied. */
  placeholder?: string
  /**
   * Optional short label or glyph rendered inside the field's leading edge
   * (e.g. `W`, `H`, `Min W`, or the line-height mark) — the Figma-style
   * in-field label. Purely visual; it doesn't affect the committed value.
   * A glyph is `aria-hidden`, so the caller's `aria-label` remains the
   * field's only accessible name either way.
   */
  prefix?: ReactNode
  /** Token catalog to suggest. Empty array → plain text input behaviour. */
  tokens: ReadonlyArray<Token>
  /** Commit handler — receives the resolved CSS expression or undefined. */
  onCommit: (resolved: string | undefined) => void
  /**
   * Optional live-preview handler. When provided, the component fires
   * `onPreview` on every keystroke and on token-row hover with the
   * resolved value, then `onClearPreview` on blur / menu-close.
   */
  onPreview?: (resolved: string | undefined) => void
  onClearPreview?: () => void
  /** Optional raw draft channel for controls that need sibling fields to mirror active typing. */
  onDraftChange?: (draft: string) => void
  onDraftClear?: () => void
  /** Side-effect fired when the input gains focus (e.g. tracking last-focused field). */
  onFocus?: () => void
  fieldSize?: 'xs' | 'sm' | 'md'
  /** Aria label for the input — required when there's no visible label. */
  'aria-label': string
  className?: string
  inputClassName?: string
  style?: CSSProperties
  /**
   * Optional dropdown menu label override. When omitted, falls back to
   * the input's aria-label.
   */
  menuAriaLabel?: string
  spellCheck?: boolean
  autoComplete?: string
  disabled?: boolean
  'data-testid'?: string
  /**
   * Render the input as a caller-positioned overlay: the wrapper uses
   * `display: contents` so it establishes no box, letting the caller
   * absolutely position the input against its own container (used by the
   * spacing box's per-side segments). Defaults to a block wrapper.
   */
  overlay?: boolean
  /**
   * When true, wrap the input in a Tooltip that surfaces the full draft
   * value on hover whenever the rendered text overflows the field and the
   * field isn't being edited (used by the narrow per-side spacing inputs).
   */
  tooltipOnOverflow?: boolean
  /**
   * Which project-variable kinds the "Apply variable" affordance offers.
   * Defaults to lengths + bare numbers — every current caller is a length
   * field. `TokenizedColorField` is the colour counterpart and passes
   * `COLOR_VARIABLE_KINDS` itself.
   */
  variableKinds?: readonly VariableKind[]
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<TokenAwareInputHandle>
}

// ---------------------------------------------------------------------------
// TokenAwareInput
// ---------------------------------------------------------------------------

export function TokenAwareInput({
  id,
  value,
  mixed = false,
  placeholder,
  prefix,
  tokens,
  onCommit,
  onPreview,
  onClearPreview,
  onDraftChange,
  onDraftClear,
  onFocus,
  fieldSize = 'sm',
  'aria-label': ariaLabel,
  className,
  inputClassName,
  style,
  menuAriaLabel,
  spellCheck = false,
  autoComplete = 'off',
  disabled,
  'data-testid': dataTestId,
  overlay = false,
  tooltipOnOverflow = false,
  variableKinds = LENGTH_VARIABLE_KINDS,
  ref,
}: TokenAwareInputProps) {
    const [isEditing, setIsEditing] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    /** Set by Escape so the blur it triggers discards instead of committing — see `onBlur`. */
    const revertingRef = useRef(false)

    // ── "Apply variable" ────────────────────────────────────────────────
    // A binding to one of this field's OWN framework tokens is deliberately
    // NOT treated as bound here: `displayTokenValue` already round-trips
    // `var(--space-md)` back to the short `md` this input's autocomplete is
    // built around, and replacing that with a chip would regress the
    // spacing/typography UX to gain nothing (the token is already named on
    // screen). The chip is for the PROJECT's own custom properties — the
    // ones with no step shorthand and no place in this dropdown.
    //
    // Read BEFORE `display`, because a bound field displays nothing: the
    // chip carries the name, and the empty input is what makes the first
    // keystroke in edit mode replace the binding with a literal.
    const binding = parseVarBinding(value)
    const isFrameworkToken =
      binding !== null && tokens.some((token) => token.varName === binding.name)
    const variable = useVariableAffordance({
      value: mixed || isFrameworkToken ? undefined : value,
      accept: variableKinds,
      onCommit,
      fieldLabel: ariaLabel,
      mixed,
      disabled,
      editing: isEditing,
      onEnterEdit: () => {
        inputRef.current?.focus()
        inputRef.current?.select()
      },
    })

    // A mixed field has no single value to display — it shows the shared
    // "Mixed" placeholder over an empty draft. Everything downstream (draft
    // sync, token suggestions, commit) then behaves exactly as it does for an
    // unset field, which is what makes the first keystroke replace "mixed"
    // with one value across the whole selection.
    const display = mixed ? '' : displayTokenValue(variable.displayValue, tokens)
    // The "Mixed" string itself is `Input`'s job (it owns the shared
    // constant); this only stops a real placeholder from competing with it.
    const placeholderDisplay = displayTokenValue(placeholder, tokens)

    // The shared "preview suggestions on hover" preference. When off,
    // hovering a token row in the dropdown doesn't fire onPreview — but
    // typing still does (live as-you-type preview is its own UX feature).
    const hoverPreviewEnabled = useEditorPreference('hoverPreview')

    // Local draft so we don't fire onCommit on every keystroke (which would
    // round-trip through Mutative + re-validate every press).
    const [draft, setDraft] = useState(display)

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }))

    // Narrow overlay fields (e.g. the spacing box's 38px sides) visually
    // truncate long values like a full `clamp(...)`. Track overflow so the
    // optional tooltip can surface the full value on hover — only measured
    // when the caller opts in via `tooltipOnOverflow`.
    const [isOverflowing, setIsOverflowing] = useState(false)
    useLayoutEffect(() => {
      if (!tooltipOnOverflow) return
      const el = inputRef.current
      if (!el) return
      setIsOverflowing(el.scrollWidth > el.clientWidth + 1)
    }, [draft, tooltipOnOverflow])

    // Sync external value → draft when not actively editing. React 19 idiom:
    // adjust state during render by tracking the previous external value.
    const [lastExternalDisplay, setLastExternalDisplay] = useState(display)
    if (!isEditing && display !== lastExternalDisplay) {
      setLastExternalDisplay(display)
      setDraft(display)
    }

    // Filter tokens by typed prefix for the autocomplete dropdown.
    // When there's no query, the "Suggested" section is hidden entirely —
    // returning [] here lets the "Tokens" section render the full scale.
    const q = draft.trim().toLowerCase()
    const suggestions = !q
      ? []
      : tokens
          .filter(
            (t) =>
              t.step.toLowerCase().startsWith(q) ||
              t.step.toLowerCase().includes(q),
          )
          .slice(0, 8)

    const commit = (raw: string) => {
      // A bound field shows an EMPTY input (the chip carries the name), so a
      // click-away that typed nothing must not read as "the user cleared
      // this" — that would destroy the binding on every stray focus. The
      // explicit ways out are typing a literal and the chip's detach ×.
      if (variable.bound && raw.trim() === '') {
        onClearPreview?.()
        onDraftClear?.()
        setIsEditing(false)
        return
      }
      const resolved = resolveTokenValue(raw, tokens)
      onClearPreview?.()
      onCommit(resolved)
      onDraftClear?.()
      setIsEditing(false)
    }

    // Preview a hovered token's value on the canvas. Gated by the
    // hoverPreview editor preference so users who don't want flicker can
    // opt out. Note: the as-you-type preview below is intentionally always
    // on, since it reflects an explicit edit the user is making.
    const previewToken = (rawValue: string) => {
      if (!hoverPreviewEnabled || !onPreview) return
      const resolved = resolveTokenValue(rawValue, tokens)
      onPreview(resolved)
    }

    // Defensive: if the preference is toggled off while a hover preview is
    // active (e.g. user flips it in another tab), clear the canvas preview
    // so nothing sticks around.
    useEffect(() => {
      if (!hoverPreviewEnabled) onClearPreview?.()
    }, [hoverPreviewEnabled, onClearPreview])

    // Live-preview a typed draft. Updates the canvas on every keystroke so
    // users see their values applied without having to press Enter / Tab /
    // blur — matches the behaviour of every modern visual builder. When the
    // current draft is provably incomplete (e.g. `var(--spa`), we skip the
    // update and keep the last valid preview on screen instead of writing
    // garbage to the engine.
    const previewDraft = (rawValue: string) => {
      if (!onPreview) return
      if (!isLivePreviewable(rawValue)) return
      const resolved = resolveTokenValue(rawValue, tokens)
      onPreview(resolved)
    }

    // Hide the dropdown when the user is typing a direct CSS value
    // (numbers, units, `auto`, `calc(...)`, etc.) — non-token typing should
    // commit on Enter/Tab/Blur without the menu intercepting outside-clicks.
    const isDirectValue = looksLikeDirectValue(draft)
    const showMenu = isEditing && !isDirectValue && tokens.length > 0

    // Split tokens into "Suggested" (matching the typed query) and "All"
    // (everything else) so users always see the full scale even when they
    // haven't started typing.
    const queryTrim = draft.trim().toLowerCase()
    const suggestedSet = new Set(suggestions.map((t) => t.varName))
    const allOthers = tokens.filter((t) => !suggestedSet.has(t.varName))
    const showSuggestedHeader = queryTrim.length > 0 && suggestions.length > 0
    const showAllHeader = allOthers.length > 0

    const inputEl = (
      <Input
        ref={inputRef}
        id={id}
        type="text"
        fieldSize={fieldSize}
        value={draft}
        prefix={prefix}
        leadingSlot={variable.chip}
        mixed={mixed}
        placeholder={placeholderDisplay}
        spellCheck={spellCheck}
        autoComplete={autoComplete}
        aria-label={ariaLabel}
        disabled={disabled}
        data-testid={dataTestId}
        className={cn(styles.input, inputClassName)}
        onFocus={() => {
          setIsEditing(true)
          onFocus?.()
        }}
        onChange={(e) => {
          const next = e.target.value
          // Re-opens the editing session after an Enter commit, which ends it
          // without blurring — otherwise the token menu would stay shut and
          // the external-value sync could clobber the new draft mid-typing.
          setIsEditing(true)
          setDraft(next)
          onDraftChange?.(next)
          previewDraft(next)
        }}
        onBlur={(e) => {
          // Escape reverts, then blurs. The blur fires before React has
          // re-rendered the reverted draft, so committing `e.target.value`
          // here would write the very text Escape discarded.
          if (revertingRef.current) {
            revertingRef.current = false
            setDraft(display)
            return
          }
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Figma: Enter commits and KEEPS focus, re-selecting the value so
            // the next keystroke replaces it. Committing closes the token
            // menu (that is what `commit` sets `isEditing` false for) without
            // taking the caret out of the field.
            e.preventDefault()
            const input = e.target as HTMLInputElement
            commit(input.value)
            requestAnimationFrame(() => input.select())
          } else if (e.key === 'Escape') {
            e.preventDefault()
            revertingRef.current = true
            setDraft(display)
            setIsEditing(false)
            onDraftClear?.()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Keyboard nudge: the one model from `numericNudge.ts` — ±1
            // (plain), ±10 (Shift), ±0.1 (Alt) — preserving
            // the unit. No-op for non-numeric values (var tokens, `auto`,
            // `calc(...)`), which fall through to the default caret behaviour.
            // An empty field starts from 0, inheriting the placeholder's unit
            // when it has one (else px — these are all length fields).
            const emptyUnit = parseNudgeableValue(placeholder ?? '')?.unit ?? 'px'
            handleNudgeKeydown(
              e,
              draft,
              (next) => {
                setDraft(next)
                onDraftChange?.(next)
                previewDraft(next)
              },
              { emptyUnit },
            )
          } else if (e.key === 'Tab') {
            // Allow default tab behaviour but commit the current value.
            commit((e.target as HTMLInputElement).value)
          }
        }}
      />
    )

    return (
      <div
        className={cn(overlay ? styles.wrapperOverlay : styles.wrapper, className)}
        style={style}
        /* Scopes the hover-reveal rule for the trailing variable button.
         * See VariableField.module.css's `[data-variable-host]` selector. */
        data-variable-host=""
      >
        {tooltipOnOverflow ? (
          <Tooltip
            content={draft}
            side="top"
            disabled={!isOverflowing || isEditing || !draft}
          >
            {inputEl}
          </Tooltip>
        ) : (
          inputEl
        )}

        {/* The trigger is absolutely positioned inside this wrapper, so it
          * needs the wrapper to be a containing block. In `overlay` mode the
          * wrapper is `display: contents` (the spacing box positions the
          * input against its OWN container), so there is nothing to anchor
          * to — those 38px per-side fields keep the chip and reach the
          * picker by clicking it, but show no hover button. */}
        {!overlay && variable.trigger}

        {showMenu &&
          createPortal(
            <ContextMenu
              anchorRef={inputRef}
              side="auto"
              align="start"
              offset={4}
              matchAnchorWidth
              minWidth={132}
              ariaLabel={menuAriaLabel ?? `${ariaLabel} variables`}
              triggerRef={inputRef}
              onClose={() => onClearPreview?.()}
              onMouseLeave={() => onClearPreview?.()}
            >
              {showSuggestedHeader && (
                <div className={styles.menuHeader} aria-hidden="true">
                  Suggested
                </div>
              )}
              {showSuggestedHeader &&
                suggestions.map((t) => (
                  <ContextMenuItem
                    key={`suggested-${t.varName}`}
                    onMouseDown={(e) => {
                      // mousedown beats blur — commits the token before
                      // the input loses focus.
                      e.preventDefault()
                      commit(t.step)
                    }}
                    onMouseEnter={() => previewToken(t.step)}
                    className={styles.menuItem}
                  >
                    <span className={styles.menuToken}>{t.step}</span>
                    <span className={styles.menuVar} title={t.valueExpr}>
                      {t.varName}
                    </span>
                  </ContextMenuItem>
                ))}
              {showAllHeader && (
                <div className={styles.menuHeader} aria-hidden="true">
                  {showSuggestedHeader ? 'All tokens' : 'Tokens'}
                </div>
              )}
              {(showAllHeader ? allOthers : tokens).map((t) => (
                <ContextMenuItem
                  key={`all-${t.varName}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commit(t.step)
                  }}
                  onMouseEnter={() => previewToken(t.step)}
                  className={styles.menuItem}
                >
                  <span className={styles.menuToken}>{t.step}</span>
                  <span className={styles.menuVar} title={t.valueExpr}>
                    {t.varName}
                  </span>
                </ContextMenuItem>
              ))}
            </ContextMenu>,
            document.body,
          )}
      </div>
    )
}
