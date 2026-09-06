import { useRef, useState, type CSSProperties, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { contrastLevel, contrastRatio, cssColorToRgb, type WcagContrastLevel } from '@core/design-tokens'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { ColorPickerPopover, isColorToken, type ColorPickerToken } from '@ui/components/ColorPickerPopover'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import styles from './controls.module.css'

type ColorVariable = ReturnType<typeof generateFrameworkColorVariableSets>['light'][number]
type TokenSwatchStyle = CSSProperties & { '--color-token-option-value'?: string }

interface TokenizedColorFieldProps {
  id?: string
  value: string
  disabled?: boolean
  inputLabel: string
  swatchLabel: string
  placeholder?: string
  excludeTokenId?: string
  monospace?: boolean
  fieldSize?: 'xs' | 'sm' | 'md'
  onTextChange: (value: string) => void
  onTextBlur: () => void
  onSwatchChange: (value: string) => void
  onTokenSelect: (value: string) => void
  /**
   * Optional hover-preview hooks. When provided, hovering a colour-token
   * option fires `onTokenPreview` with its `var(--…)` reference; leaving the
   * row / closing the menu fires `onTokenPreviewClear`. The caller
   * (ColorControl) only passes these when the `hoverPreview` preference is on,
   * so this field stays preview-agnostic.
   */
  onTokenPreview?: (value: string) => void
  onTokenPreviewClear?: () => void
  /**
   * A resolved CSS colour (hex/`rgb()`/`hsl()`) to compute a live WCAG
   * contrast badge against — the intended use is the element's own resolved
   * background. T9 (`STUDIO-FIGMA-PARITY-PLAN.md` §11): `contrastRatio` had
   * zero imports from `src/` before this — an agent could report a design's
   * contrast ratio, but a human picking a colour here got no signal at all.
   * Omitted by a caller that doesn't have a background to compare against
   * yet — the badge simply doesn't render; nothing else changes.
   */
  contrastAgainst?: string
}

/** `AA 7.2` / `AAA 12.1` / `2.3:1` (below AA — the ratio itself, not a false pass label) — one line, computed from `contrastAgainst`. */
function contrastBadgeFor(value: string, contrastAgainst: string | undefined): { level: WcagContrastLevel; label: string } | null {
  if (!contrastAgainst) return null
  const fg = cssColorToRgb(value)
  const bg = cssColorToRgb(contrastAgainst)
  if (!fg || !bg) return null
  const ratio = Math.round(contrastRatio(fg, bg) * 10) / 10
  const level = contrastLevel(ratio)
  return { level, label: level === 'fail' ? `${ratio}:1` : `${level} ${ratio}` }
}

export function TokenizedColorField({
  id,
  value,
  disabled = false,
  inputLabel,
  swatchLabel,
  placeholder,
  excludeTokenId,
  monospace = false,
  fieldSize = 'sm',
  onTextChange,
  onTextBlur,
  onSwatchChange,
  onTokenSelect,
  onTokenPreview,
  onTokenPreviewClear,
  contrastAgainst,
}: TokenizedColorFieldProps) {
  const colorSettings = useEditorStore((state) => state.site?.settings.framework?.colors)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const swatchButtonRef = useRef<HTMLButtonElement>(null)
  const variables = generateFrameworkColorVariableSets(colorSettings).light
    .filter((variable) => variable.tokenId !== excludeTokenId)
  const filteredVariables = computeFilteredVariables(value, variables)
  const appliedVariable = resolveTokenReferenceVariable(value, variables)
  const swatchValue = appliedVariable?.value ?? value
  const menuId = id ? `${id}-token-menu` : undefined
  const showMenu = open && !disabled && filteredVariables.length > 0

  // ── ColorPickerPopover wiring (G6.2, `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`) ──
  // The swatch button opens the real picker (SV square, hue/alpha rails,
  // model select, eyedropper, contrast, Tabs) as an `InspectorPopover`
  // anchored to itself — separate from `open` above, which still drives the
  // inline type-ahead token listbox the TEXT field opens. Both can name the
  // same token catalogue without duplicating it: `pickerTokens` is the same
  // `variables` list the listbox filters, just reshaped to the primitive's
  // generic `ColorPickerToken` shape (a `src/ui/` component must not know
  // what a `FrameworkColorToken` is).
  const pickerTokens: ColorPickerToken[] = variables.map((variable) => ({
    id: `${variable.tokenId}-${variable.variantId}`,
    name: variable.name,
    value: variable.value,
    meta: variable.variantName,
  }))
  const appliedTokenId = appliedVariable ? `${appliedVariable.tokenId}-${appliedVariable.variantId}` : undefined
  // "On this page" (F14) — the honest version of this today: the project's
  // own colour tokens plus whatever custom (non-token) value is currently
  // set. Studio has no per-file colour-usage history to draw on yet.
  const recentColors = computeRecentColors(variables, value)
  const pickerId = id ? `${id}-picker` : `color-picker-${inputLabel}`

  // Reset the keyboard-highlight to the first option whenever `value` (and
  // therefore `filteredVariables`) changes. Done as a render-time
  // "previous-value" comparison rather than a useEffect+setState, so we
  // don't incur an extra render pass per keystroke.
  const [lastValue, setLastValue] = useState(value)
  if (lastValue !== value) {
    setLastValue(value)
    setActiveIndex(0)
  }

  function handleTextFocus() {
    if (!disabled) setOpen(true)
  }

  function handleTextBlur(event: FocusEvent<HTMLInputElement>) {
    onTextBlur()
    if (event.relatedTarget instanceof HTMLElement && event.currentTarget.parentElement?.contains(event.relatedTarget)) {
      return
    }
    onTokenPreviewClear?.()
    window.setTimeout(() => setOpen(false), 0)
  }

  function handleTextChange(event: ChangeEvent<HTMLInputElement>) {
    onTextChange(event.target.value)
    setOpen(true)
  }

  function commitToken(variable: ColorVariable) {
    onTokenPreviewClear?.()
    onTokenSelect(`var(${variable.name})`)
    setOpen(false)
  }

  /**
   * T8 (`STUDIO-FIGMA-PARITY-PLAN.md` §11) / G6.2
   * (`STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`) — the swatch used to be a native
   * `<input type="color">` (no alpha, no eyedropper, no token awareness),
   * then a token listbox with an escape hatch to that same native dialog.
   * It now opens `ColorPickerPopover` directly — a real HSV picker with an
   * alpha rail, plus a Tokens tab that replaces the old "Custom colour…"
   * detour entirely.
   */
  function handleSwatchTriggerClick() {
    if (disabled) return
    setOpen(false)
    setPickerOpen((wasOpen) => !wasOpen)
  }

  /**
   * The popover's single `onChange` covers three sources: a Custom-tab edit
   * (hex/rgb()/hsl()), its raw-value fallback, a Tokens-tab pick, or an "On
   * this page" swatch — the last two may themselves be `var(--…)`
   * references, which routes to `onTokenSelect` instead of `onSwatchChange`
   * so both existing commit paths (and their side effects) stay exactly as
   * every other caller of this field already expects.
   */
  function handlePickerChange(next: string) {
    if (isColorToken(next)) {
      onTokenPreviewClear?.()
      onTokenSelect(next)
    } else {
      onSwatchChange(next)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!showMenu) {
      if (event.key === 'ArrowDown' && filteredVariables.length > 0) {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      onTokenPreviewClear?.()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, filteredVariables.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commitToken(filteredVariables[activeIndex])
    }
  }

  const currentContrast = contrastBadgeFor(swatchValue, contrastAgainst)

  return (
    <div className={styles.colorRow}>
      <div className={styles.colorField} data-color-field="true">
        <Button
          ref={swatchButtonRef}
          type="button"
          variant="ghost"
          size="micro"
          iconOnly
          disabled={disabled}
          onClick={handleSwatchTriggerClick}
          aria-label={swatchLabel}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          className={styles.colorSwatchTrigger}
        >
          <span
            className={styles.colorTokenOptionSwatch}
            style={{ '--color-token-option-value': swatchValue } as TokenSwatchStyle}
            aria-hidden="true"
          />
        </Button>
        {pickerOpen && (
          <ColorPickerPopover
            id={pickerId}
            anchorRef={swatchButtonRef}
            onClose={() => setPickerOpen(false)}
            title={inputLabel}
            value={swatchValue}
            appliedTokenId={appliedTokenId}
            onChange={handlePickerChange}
            onPreview={onTokenPreview}
            onClearPreview={onTokenPreviewClear}
            tokens={pickerTokens}
            recentColors={recentColors}
            contrastAgainst={contrastAgainst}
          />
        )}
        <Input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          fieldSize={fieldSize}
          monospace={monospace}
          onFocus={handleTextFocus}
          onMouseDown={() => {
            if (!disabled) setOpen(true)
          }}
          onChange={handleTextChange}
          onBlur={handleTextBlur}
          onKeyDown={handleKeyDown}
          aria-label={inputLabel}
          aria-controls={showMenu ? menuId : undefined}
          aria-expanded={showMenu ? true : undefined}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(styles.colorText, styles.colorTextWithPreview)}
        />
        {currentContrast && (
          <span
            className={cn(styles.colorContrastBadge, styles[`colorContrastBadge-${currentContrast.level}`])}
            title="WCAG contrast against the resolved background"
          >
            {currentContrast.label}
          </span>
        )}
        {showMenu && (
          <div className={styles.colorTokenMenuWrap}>
            <div
              id={menuId}
              role="listbox"
              aria-label={`${inputLabel} color tokens`}
              className={styles.colorTokenMenu}
              onMouseLeave={() => onTokenPreviewClear?.()}
            >
              {filteredVariables.map((variable, index) => {
                const optionContrast = contrastBadgeFor(variable.value, contrastAgainst)
                return (
                  <button
                    key={`${variable.tokenId}-${variable.variantId}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={styles.colorTokenOption}
                    onMouseEnter={() => {
                      setActiveIndex(index)
                      onTokenPreview?.(`var(${variable.name})`)
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commitToken(variable)}
                  >
                    <span
                      className={styles.colorTokenOptionSwatch}
                      style={{ '--color-token-option-value': variable.value } as TokenSwatchStyle}
                      aria-hidden="true"
                    />
                    <span className={styles.colorTokenOptionText}>
                      <span className={styles.colorTokenOptionName}>{variable.name}</span>
                      {variable.variantName && (
                        <span className={styles.colorTokenOptionMeta}>{variable.variantName}</span>
                      )}
                    </span>
                    {optionContrast && (
                      <span
                        className={cn(styles.colorContrastBadge, styles[`colorContrastBadge-${optionContrast.level}`])}
                      >
                        {optionContrast.label}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function computeFilteredVariables(value: string, variables: ColorVariable[]): ColorVariable[] {
  const query = colorTokenSearchQuery(value)
  if (!query) return variables.slice(0, 32)
  return variables.filter((variable) => tokenVariableMatches(variable, query)).slice(0, 32)
}

function colorTokenSearchQuery(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const variableMatch = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(trimmed)
  const tokenishValue = variableMatch?.[1] ?? trimmed
  if (tokenishValue.startsWith('--')) return tokenishValue.slice(2)
  if (/^[a-z0-9_-]+$/.test(tokenishValue)) return tokenishValue
  return ''
}

function tokenVariableMatches(variable: ColorVariable, query: string): boolean {
  const name = variable.name.slice(2).toLowerCase()
  return name.includes(query) ||
    variable.slug.toLowerCase().includes(query) ||
    (variable.variantName?.toLowerCase().includes(query) ?? false)
}

function resolveTokenReferenceVariable(value: string, variables: ColorVariable[]): ColorVariable | undefined {
  const variableName = /^var\(\s*(--[a-z0-9_-]+)\s*\)$/i.exec(value.trim())?.[1]
  if (!variableName) return undefined
  return variables.find((variable) => variable.name === variableName)
}

/** "On this page" (F14) — see `ColorPickerPopover`'s doc for why this is honestly just the token catalogue plus whatever custom value is live. */
function computeRecentColors(variables: ColorVariable[], value: string): string[] {
  const seen = new Set<string>()
  const recents: string[] = []
  const trimmed = value.trim()
  if (trimmed !== '' && !isColorToken(trimmed)) {
    seen.add(trimmed)
    recents.push(trimmed)
  }
  for (const variable of variables) {
    if (recents.length >= 12) break
    if (seen.has(variable.value)) continue
    seen.add(variable.value)
    recents.push(variable.value)
  }
  return recents
}
