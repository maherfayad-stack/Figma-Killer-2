/**
 * ColorPickerPopover — Figma's floating colour picker (F14 in
 * `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`), built on `InspectorPopover` so it
 * opens to the LEFT of the inspector by default and never covers the field
 * being edited.
 *
 * A `src/ui/components/` primitive: no dependency on `src/admin` or the
 * site editor store (see `InspectorPopover.tsx`'s "STICKY VIEW STATE" doc for
 * why that boundary matters — this component is portable to plugins). Every
 * piece of project-specific data — the colour token catalogue, "on this
 * page" recents, the resolved background to contrast against — is a prop,
 * not something this component looks up itself. `TokenizedColorField`
 * (`src/admin/pages/site/property-controls/`) is the first caller and
 * resolves all three from the editor store before rendering this.
 *
 * SINGLE-COLOUR API — this is what a gradient-stop editor (or any other
 * "edit one colour" caller) should mount:
 *
 *     {open && (
 *       <ColorPickerPopover
 *         id={`gradient-stop-${stop.id}`}
 *         anchorRef={stopSwatchRef}
 *         onClose={() => setOpen(false)}
 *         value={stop.color}        // a resolved CSS colour, NOT a var() ref
 *         onChange={(next) => updateStop(stop.id, { color: next })}
 *       />
 *     )}
 *
 * `tokens` / `recentColors` / `contrastAgainst` are all optional — omit them
 * and the picker degrades to exactly the Custom tab (no Tokens tab, no "On
 * this page" strip, no contrast readout). Gradients themselves are OUT of
 * scope here; this edits one flat colour.
 *
 * PARSE BOUNDARY — `colorParsing.ts` is this component's "never lie" gate.
 * `value` is parsed once per render; if it does not parse (and is not a
 * `var()` reference — resolve those before calling this component), the
 * Custom tab falls back to a single text field showing the value exactly as
 * given. No square, no rails, and critically: `onChange` is never called
 * just because the popover opened. The user must explicitly edit the raw
 * field for anything to be rewritten — that edit is then whatever they
 * typed, verbatim, not a "corrected" guess.
 *
 * DRAG MODEL — the saturation/value square, hue rail, and alpha rail follow
 * `ScrubInput`'s convention exactly: local state (and the `onPreview`
 * channel, rAF-coalesced) updates on every `pointermove`, `onChange` (the
 * real commit) fires once on `pointerup`. Pointer CAPTURE (not a window
 * listener in an effect) keeps the drag alive once the cursor leaves the
 * small rail — same technique, same reason.
 *
 * HSV vs HSL — the drag surfaces operate in HSV (hue/saturation/value)
 * because that is what a 2D saturation/value square *is*. The HSL model tab
 * is a different textual representation of the same colour, not a different
 * picking space; every conversion pivots through `Rgba` so there is exactly
 * one rounding policy (see `colorParsing.ts`'s doc).
 */
import {
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { contrastLevel, contrastRatio, cssColorToRgb, type WcagContrastLevel } from '@core/design-tokens'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { InspectorPopover, type InspectorPopoverProps } from '@ui/components/InspectorPopover'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import {
  formatColor,
  hsvaToRgba,
  parseCssColor,
  rgbaToHsva,
  type ColorModel,
  type Hsva,
  type Rgba,
} from './colorParsing'
import { getEyeDropperConstructor } from './eyedropper'
import { RecentsStrip, TokensPanel, type PickerStyle } from './ColorPickerPopoverPanels'
import { useRafScheduler } from './useRafScheduler'
import type { ColorPickerToken } from './types'
import styles from './ColorPickerPopover.module.css'

export type { ColorPickerToken } from './types'

export interface ColorPickerPopoverProps {
  /** Stable identity for the trigger — forwarded to `InspectorPopover`. */
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  /** Header title. Default `'Color'`. */
  title?: string
  /**
   * The colour to edit, as a RESOLVED CSS colour string — hex / `rgb()` /
   * `hsl()` / a supported named colour. Never a `var()` reference: resolve
   * a token to its value before calling this component, and pass the
   * token's id separately as `appliedTokenId`.
   */
  value: string
  /** The token currently applied, if any (must match an entry in `tokens`). Highlights that row and defaults the open tab to Tokens (F14: token-applied colours read token-first). */
  appliedTokenId?: string
  /**
   * Fires with the value to commit: a hex/`rgb()`/`hsl()` string from the
   * Custom tab or the raw-value fallback, or `var(--token-name)` from the
   * Tokens tab or a recent swatch.
   */
  onChange: (next: string) => void
  /** Live-drag / hover preview channel, rAF-coalesced — see the file doc. */
  onPreview?: (next: string) => void
  onClearPreview?: () => void
  /** The project's colour token catalogue. Omit (or pass `[]`) to hide the Tokens tab entirely (Law 1: no tokens, no tab). */
  tokens?: ReadonlyArray<ColorPickerToken>
  /**
   * Resolved CSS colours for the "On this page" strip. Today this is
   * honestly just "the project's tokens plus the value being edited" —
   * Studio has no per-file colour-usage history yet. Omit to hide the strip.
   */
  recentColors?: ReadonlyArray<string>
  /** A resolved CSS colour to compute a live WCAG contrast badge against. Omitted by a caller with no background to compare. */
  contrastAgainst?: string
  /** Overrides the computed default (Tokens-first when `appliedTokenId` is set and `tokens` is non-empty, else Custom). */
  defaultTab?: 'custom' | 'tokens'
  side?: InspectorPopoverProps['side']
  align?: InspectorPopoverProps['align']
  offset?: number
  width?: number
}

// ---------------------------------------------------------------------------
// Pointer-ratio helper shared by the SV square and both rails
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function ratiosFromEvent(e: ReactPointerEvent<HTMLDivElement>, rect: DOMRect): { x: number; y: number } {
  const x = rect.width === 0 ? 0 : clamp01((e.clientX - rect.left) / rect.width)
  const y = rect.height === 0 ? 0 : clamp01((e.clientY - rect.top) / rect.height)
  return { x, y }
}

// A full-spectrum rainbow. Colour DATA the hue rail renders (every possible
// hue), not decorative chrome — see the module CSS header comment and
// CLAUDE.md §"Styling rules" for the sanctioned inline-custom-property
// exception this is built on.
const HUE_RAIL_GRADIENT =
  'linear-gradient(to right, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), ' +
  'hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))'

// ---------------------------------------------------------------------------
// Contrast badge — mirrors TokenizedColorField's `contrastBadgeFor` exactly
// (same thresholds, same label shape) so the popover's readout never
// disagrees with the field's own badge. Duplicated rather than imported: a
// `src/ui/` primitive must not depend on an `src/admin` file.
// ---------------------------------------------------------------------------

function contrastBadgeFor(
  rgba: Rgba,
  against: string | undefined,
): { level: WcagContrastLevel; label: string } | null {
  if (!against) return null
  const bg = cssColorToRgb(against)
  if (!bg) return null
  const ratio = Math.round(contrastRatio(rgba, bg) * 10) / 10
  const level = contrastLevel(ratio)
  return { level, label: level === 'fail' ? `${ratio}:1` : `${level} ${ratio}` }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const MODEL_OPTIONS: ReadonlyArray<{ value: ColorModel; label: string }> = [
  { value: 'hex', label: 'HEX' },
  { value: 'rgb', label: 'RGB' },
  { value: 'hsl', label: 'HSL' },
]

export function ColorPickerPopover({
  id,
  anchorRef,
  onClose,
  title = 'Color',
  value,
  appliedTokenId,
  onChange,
  onPreview,
  onClearPreview,
  tokens,
  recentColors,
  contrastAgainst,
  defaultTab,
  side,
  align,
  offset,
  width,
}: ColorPickerPopoverProps) {
  const hasTokensTab = (tokens?.length ?? 0) > 0
  const tokenApplied = appliedTokenId != null && hasTokensTab

  const parsed = parseCssColor(value)

  // Local drag/edit state, resynced from `value` only when it changes for a
  // reason OTHER than our own last commit — the React 19 "adjust state
  // during render" idiom used throughout this codebase's field controls
  // (see TokenizedColorField's `lastValue` comparison).
  const [hsva, setHsva] = useState<Hsva>(() => (parsed ? rgbaToHsva(parsed.rgba) : { h: 0, s: 0, v: 0, a: 1 }))
  const [lastExternalValue, setLastExternalValue] = useState(value)
  if (value !== lastExternalValue) {
    setLastExternalValue(value)
    const reparsed = parseCssColor(value)
    if (reparsed) setHsva(rgbaToHsva(reparsed.rgba))
  }

  const [model, setModel] = useState<ColorModel>(() => parsed?.model ?? 'hex')

  const [activeTab, setActiveTab] = useState<'custom' | 'tokens'>(
    () => defaultTab ?? (tokenApplied ? 'tokens' : 'custom'),
  )

  const rgbaNow = hsvaToRgba(hsva)
  const formattedValue = formatColor(rgbaNow, model)

  // The value text field's own draft buffer — typing is authoritative and
  // is never reformatted mid-keystroke. Resynced only when NOT actively
  // editing, or when the model tab itself changes (an explicit user action
  // that legitimately reformats the field).
  const [valueDraft, setValueDraft] = useState(formattedValue)
  const [isEditingValue, setIsEditingValue] = useState(false)
  const [lastModel, setLastModel] = useState(model)
  const [lastSyncedFormatted, setLastSyncedFormatted] = useState(formattedValue)
  if (model !== lastModel) {
    setLastModel(model)
    setLastSyncedFormatted(formattedValue)
    setValueDraft(formattedValue)
    setIsEditingValue(false)
  } else if (!isEditingValue && formattedValue !== lastSyncedFormatted) {
    setLastSyncedFormatted(formattedValue)
    setValueDraft(formattedValue)
  }

  // The unparseable-value fallback's own verbatim draft — see the file doc's
  // "PARSE BOUNDARY" section. Never reformatted; only replaced by whatever
  // the user actually types.
  const [rawDraft, setRawDraft] = useState(value)
  const [rawEditing, setRawEditing] = useState(false)
  const [lastRawValue, setLastRawValue] = useState(value)
  if (!rawEditing && value !== lastRawValue) {
    setLastRawValue(value)
    setRawDraft(value)
  }

  const { schedule: schedulePreview, cancel: cancelPreview } = useRafScheduler()

  function commitHsva(next: Hsva) {
    setHsva(next)
    const nextRgba = hsvaToRgba(next)
    const nextValue = formatColor(nextRgba, model)
    setLastExternalValue(nextValue)
    onChange(nextValue)
  }

  function previewHsva(next: Hsva) {
    schedulePreview(() => onPreview?.(formatColor(hsvaToRgba(next), model)))
  }

  function endDrag(next: Hsva) {
    cancelPreview()
    onClearPreview?.()
    commitHsva(next)
  }

  // ── Saturation/value square ────────────────────────────────────────────
  function handleSvDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!parsed) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    applySv(e)
  }
  function handleSvMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    applySv(e)
  }
  function handleSvUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const { x, y } = ratiosFromEvent(e, rect)
    endDrag({ ...hsva, s: x * 100, v: (1 - y) * 100 })
  }
  function applySv(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const { x, y } = ratiosFromEvent(e, rect)
    const next: Hsva = { ...hsva, s: x * 100, v: (1 - y) * 100 }
    setHsva(next)
    previewHsva(next)
  }

  // ── Hue rail ────────────────────────────────────────────────────────────
  function handleHueDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!parsed) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    applyHue(e)
  }
  function handleHueMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    applyHue(e)
  }
  function handleHueUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const { x } = ratiosFromEvent(e, rect)
    endDrag({ ...hsva, h: x * 360 })
  }
  function applyHue(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const { x } = ratiosFromEvent(e, rect)
    const next: Hsva = { ...hsva, h: x * 360 }
    setHsva(next)
    previewHsva(next)
  }

  // ── Alpha rail ──────────────────────────────────────────────────────────
  function handleAlphaDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!parsed) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    applyAlpha(e)
  }
  function handleAlphaMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    applyAlpha(e)
  }
  function handleAlphaUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const { x } = ratiosFromEvent(e, rect)
    endDrag({ ...hsva, a: x })
  }
  function applyAlpha(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const { x } = ratiosFromEvent(e, rect)
    const next: Hsva = { ...hsva, a: x }
    setHsva(next)
    previewHsva(next)
  }

  // ── Model value field ───────────────────────────────────────────────────
  function commitValueField() {
    setIsEditingValue(false)
    const candidate = parseCssColor(valueDraft)
    if (!candidate) {
      setValueDraft(formattedValue)
      return
    }
    const nextHsva = rgbaToHsva(candidate.rgba)
    setHsva(nextHsva)
    const nextValue = formatColor(candidate.rgba, model)
    setLastSyncedFormatted(nextValue)
    setLastExternalValue(nextValue)
    setValueDraft(nextValue)
    onChange(nextValue)
  }

  // ── Raw (unparseable) fallback field ────────────────────────────────────
  function commitRaw() {
    setRawEditing(false)
    if (rawDraft !== value) {
      setLastRawValue(rawDraft)
      onChange(rawDraft)
    }
  }

  // ── Eyedropper ──────────────────────────────────────────────────────────
  const eyedropperSupported = getEyeDropperConstructor() != null

  async function handleEyedropper() {
    const Ctor = getEyeDropperConstructor()
    if (!Ctor) return
    try {
      const result = await new Ctor().open()
      const picked = parseCssColor(result.sRGBHex)
      if (!picked) return
      const nextHsva = rgbaToHsva(picked.rgba)
      setHsva(nextHsva)
      const nextValue = formatColor(hsvaToRgba(nextHsva), model)
      setLastExternalValue(nextValue)
      onChange(nextValue)
    } catch (err) {
      // The user closing the eyedropper overlay without picking anything is
      // not a failure — it's the documented cancel path for this API.
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.error('[ColorPickerPopover] eyedropper failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not pick a colour',
        body: getErrorMessage(err, 'Unknown eyedropper error'),
      })
    }
  }

  // ── Token / recent pick ─────────────────────────────────────────────────
  function handleTokenPick(next: string) {
    onClearPreview?.()
    onChange(next)
  }

  const contrast = contrastBadgeFor(rgbaNow, contrastAgainst)
  const pureHueColor = `hsl(${hsva.h} 100% 50%)`
  const opaqueColor = `rgb(${rgbaNow.r} ${rgbaNow.g} ${rgbaNow.b})`

  const customPanel: ReactNode = parsed ? (
    <div className={styles.customPanel}>
      <div
        className={styles.svSquare}
        style={{ '--picker-sv-base': pureHueColor } as PickerStyle}
        onPointerDown={handleSvDown}
        onPointerMove={handleSvMove}
        onPointerUp={handleSvUp}
      >
        <span
          className={styles.svThumb}
          style={{
            '--picker-thumb-x': `${hsva.s}%`,
            '--picker-thumb-y': `${100 - hsva.v}%`,
            '--picker-thumb-color': formattedValue,
          } as PickerStyle}
        />
      </div>

      <div
        className={styles.hueRail}
        style={{ '--picker-hue-gradient': HUE_RAIL_GRADIENT } as PickerStyle}
        onPointerDown={handleHueDown}
        onPointerMove={handleHueMove}
        onPointerUp={handleHueUp}
      >
        <span
          className={styles.railThumb}
          style={{ '--picker-thumb-x': `${(hsva.h / 360) * 100}%`, '--picker-thumb-color': pureHueColor } as PickerStyle}
        />
      </div>

      <div
        className={styles.alphaRail}
        style={{ '--picker-alpha-gradient': `linear-gradient(to right, transparent, ${opaqueColor})` } as PickerStyle}
        onPointerDown={handleAlphaDown}
        onPointerMove={handleAlphaMove}
        onPointerUp={handleAlphaUp}
      >
        <span
          className={styles.railThumb}
          style={{ '--picker-thumb-x': `${hsva.a * 100}%`, '--picker-thumb-color': formattedValue } as PickerStyle}
        />
      </div>

      <div className={styles.controlsRow}>
        <span className={styles.swatch} style={{ '--picker-swatch-value': formattedValue } as PickerStyle} aria-hidden="true" />
        <SegmentedControl
          value={model}
          options={MODEL_OPTIONS}
          onChange={setModel}
          size="xs"
          aria-label="Colour model"
          className={styles.modelSelect}
        />
        {eyedropperSupported && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Pick a colour from the screen"
            tooltip="Pick a colour from the screen"
            onClick={handleEyedropper}
          >
            <TargetSolidIcon size={14} aria-hidden="true" />
          </Button>
        )}
      </div>

      <Input
        value={valueDraft}
        onChange={(e) => setValueDraft(e.target.value)}
        onFocus={() => setIsEditingValue(true)}
        onBlur={commitValueField}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            setValueDraft(formattedValue)
            setIsEditingValue(false)
            e.currentTarget.blur()
          }
        }}
        aria-label={`${title} value`}
        monospace
        fieldSize="sm"
        spellCheck={false}
      />

      {contrast && (
        <div
          className={cn(styles.contrastBadge, styles[`contrastBadge-${contrast.level}`])}
          title="WCAG contrast against the resolved background"
        >
          {contrast.level === 'fail' ? <CloseIcon size={11} aria-hidden="true" /> : <CheckIcon size={11} aria-hidden="true" />}
          <span>{contrast.label}</span>
        </div>
      )}
    </div>
  ) : (
    <div className={styles.unparseablePanel}>
      <p className={styles.unparseableNote}>Can&apos;t preview this value visually — showing it exactly as written.</p>
      <Input
        value={rawDraft}
        onChange={(e) => setRawDraft(e.target.value)}
        onFocus={() => setRawEditing(true)}
        onBlur={commitRaw}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label={`${title} value`}
        monospace
        fieldSize="sm"
        spellCheck={false}
      />
    </div>
  )

  return (
    <InspectorPopover
      id={id}
      anchorRef={anchorRef}
      onClose={onClose}
      title={title}
      side={side}
      align={align}
      offset={offset}
      width={width}
    >
      <div className={styles.root}>
        {hasTokensTab ? (
          <Tabs value={activeTab} onChange={(next) => setActiveTab(next as 'custom' | 'tokens')}>
            <TabList ariaLabel={`${title} sections`}>
              {(tokenApplied ? (['tokens', 'custom'] as const) : (['custom', 'tokens'] as const)).map((tabValue) => (
                <Tab key={tabValue} value={tabValue}>
                  {tabValue === 'custom' ? 'Custom' : 'Tokens'}
                </Tab>
              ))}
            </TabList>
            <TabPanel value="custom">{customPanel}</TabPanel>
            <TabPanel value="tokens">
              <TokensPanel
                tokens={tokens ?? []}
                appliedTokenId={appliedTokenId}
                onPick={handleTokenPick}
                onPreview={onPreview}
                onClearPreview={onClearPreview}
              />
            </TabPanel>
          </Tabs>
        ) : (
          customPanel
        )}
        <RecentsStrip colors={recentColors} onPick={handleTokenPick} />
      </div>
    </InspectorPopover>
  )
}
