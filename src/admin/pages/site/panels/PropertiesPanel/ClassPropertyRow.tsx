/**
 * ClassPropertyRow — unified CSS property editing row.
 *
 * Renders a single CSSPropertyBag entry as a typed control row.
 * Uses the SAME property-control components as the Module section
 * (TextControl / ColorControl / SelectControl),
 * producing byte-identical DOM + className tokens (PP-18 acceptance criterion).
 *
 * A remove button is overlaid on each row via position:absolute so the
 * control itself is visually unchanged from a module property row.
 *
 * Phase 3 / Task #464 / Spec #671.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import { TextControl } from '@site/property-controls/TextControl'
import { ColorControl } from '@site/property-controls/ColorControl'
import { SelectControl } from '@site/property-controls/SelectControl'
import { BackgroundImageControl } from '@site/property-controls/BackgroundImageControl'
import { FontFamilyControl } from '@site/property-controls/FontFamilyControl'
import { useEditorStore } from '@site/store/store'
import { ControlRow, type ControlRowLayout } from '@ui/components/ControlRow'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import {
  useSpacingTokens,
  useTypographyTokens,
  type Token,
} from '@site/property-controls/tokenUtils'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import {
  getCSSPropertyControlType,
  getCSSPropertyTokenSource,
  getEnumOptions,
  cssPropertyLabel,
  isLengthNudgeProp,
  NUMBER_TYPED_PROPS,
} from './cssControlTypes'
import {
  getIconEnumOptions,
  getPropertyFieldGlyph,
  isSelfDescribingProperty,
} from './cssPropertyIcons'
import { parseNudgeableValue } from '@site/property-controls/numericNudge'
import { getFontWeightOptions } from './fontWeightOptions'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './ClassPropertyRow.module.css'

// ---------------------------------------------------------------------------
// PropertyGlyph — the in-field mark, rendered through a stable component.
//
// The glyph is looked up per property from a map, so it is a component VALUE
// computed during render. Rendering it inline resets its state on every pass
// (`react-hooks/static-components`); taking it as a prop on a module-scope
// component does not. Same shape as `StyleCategoryRail`'s `ModuleRailButton`.
//
// The local is `Mark`, not `Icon`: `direct-icon-imports.test.ts` is a
// plain-text scan for the literal opening tag of a lazy `Icon` wrapper, and a
// local variable of that name trips it even though nothing lazy is involved.
// ---------------------------------------------------------------------------

function PropertyGlyph({ icon: Mark }: { icon: IconComponent }) {
  return <Mark size={13} aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// ClassPropertyRow
// ---------------------------------------------------------------------------

interface ClassPropertyRowProps {
  property: keyof CSSPropertyBag
  value: string | number | undefined
  placeholder?: string | number
  fontFamilyValue?: unknown
  isSet?: boolean
  /**
   * Row layout. `stacked` (the default) is the inspector's compact cell: the
   * row resolves per property to a caption, a bare field, or an icon toggle
   * group — see `resolvedLayout` below. `inline` opts a row back into the
   * side-label column, and exists for the rare row whose control is too wide
   * to sit under its own name.
   *
   * The default used to be `inline`, and every section that wanted Figma's
   * density had to say `stacked` at each call site — which meant a section
   * nobody had converted yet silently kept the label gutter, and the panel
   * read as two designs stacked on top of each other. Every caller of this
   * component is the properties panel, so the panel's own rhythm is the
   * honest default.
   */
  layout?: 'inline' | 'stacked'
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Optional hover-preview hooks. When provided, the row forwards them to
   * whichever control supports a suggestion dropdown (token autocomplete,
   * colour-token menu, enum select) so hovering a suggestion transiently
   * applies it to the canvas. `onClearPreview` fires on leave / close.
   * Gating against the `hoverPreview` preference happens inside the leaf
   * controls, so the row can pass these through unconditionally.
   */
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
  /**
   * Track F1 — winner/loser provenance for this property, when the caller
   * computed one (`StyleSurface`'s `provenanceByProperty`, threaded through
   * `StyleSectionsEditor`). Purely additive: renders a small strip of every
   * OTHER place that declares this property (struck through — "shadowed
   * declarations render struck-through rather than hidden; seeing why a
   * value lost is the entire point"), below the control. Never changes which
   * value the control itself shows or edits — `value`/`placeholder`/`isSet`
   * above, driven by the caller's own target-specific bag, are unchanged.
   *
   * F2 seam: a locked/refused WRITE reason for this specific row (e.g. this
   * property resolved from a code expression) is a SEPARATE fact from
   * provenance and is not modeled here yet — `InlineStyleComposer`'s
   * `lockedPropertySet` currently short-circuits `onChange`/`onRemove`
   * before this component ever sees the row. When F2's `EditConstraint`
   * lands (`editConstraint.ts`, `scope: 'style-property'`), the natural next
   * step is a `constraint?: EditConstraint` prop here, rendered as a
   * lock glyph next to (not replacing) this provenance strip.
   */
  provenance?: PropertyProvenance
}

export function ClassPropertyRow({
  property,
  value,
  placeholder,
  fontFamilyValue,
  isSet = true,
  layout = 'stacked',
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  provenance,
}: ClassPropertyRowProps) {
  const type = getCSSPropertyControlType(property)
  const tokenSource = getCSSPropertyTokenSource(property)
  const label = cssPropertyLabel(String(property))
  // The two ways this row sheds its label column: an enum that draws itself
  // as a toggle group, and a length whose meaning rides inside the field as a
  // glyph. Both are `undefined` for most properties, which keep a word.
  const iconEnumOptions = getIconEnumOptions(property)
  const FieldGlyph = getPropertyFieldGlyph(property)

  /*
   * `stacked` is the caller saying "this is a cell in a compact paired grid",
   * not a finished layout decision — what a cell actually draws depends on
   * the property. This resolves it in one place so every compact section
   * agrees.
   *
   * Three ways a cell sheds its caption, and one way it keeps it:
   *   - an icon toggle group needs no words at all;
   *   - a glyph inside the field already names it, and printing the name
   *     above it too is the same word twice — which is exactly the "unneeded
   *     titles" the panel was carrying;
   *   - `Bold` / `16px` / `border-box` name themselves;
   *   - everything else keeps the small caption Figma gives it, because
   *     `nowrap` or `space-between` alone is cryptic.
   */
  const resolvedLayout: ControlRowLayout =
    layout !== 'stacked'
      ? (layout ?? 'inline')
      : iconEnumOptions || FieldGlyph || isSelfDescribingProperty(property)
        ? 'bare'
        : 'caption'

  // A glyph replaces a label column; in `inline` layout the column is still
  // there, so showing both would name the field twice.
  const glyphPrefix =
    FieldGlyph && resolvedLayout !== 'inline'
      ? <PropertyGlyph icon={FieldGlyph} />
      : undefined
  const placeholderText = placeholder !== undefined ? String(placeholder) : undefined
  const fonts = useEditorStore((state) => state.site?.settings.fonts ?? null)

  // Always read both token catalogs — hooks must run unconditionally on
  // every render. The selected catalog is forwarded to TokenAwareInput
  // when the property has a `tokenSource`, otherwise it's unused (no cost).
  const spacingTokens = useSpacingTokens()
  const typographyTokens = useTypographyTokens()
  const tokens: ReadonlyArray<Token> =
    tokenSource === 'typography'
      ? typographyTokens
      : tokenSource === 'spacing'
        ? spacingTokens
        : []

  // Translate a control's (propKey, val) onChange signature into a typed
  // CSSPropertyBag value, coercing to number when the property expects one.
  const handleControlChange = (_key: string, val: unknown) => {
    const nextValue = String(val ?? '')
    if (NUMBER_TYPED_PROPS.has(property)) {
      const parsed = Number(nextValue)
      onChange(property, Number.isFinite(parsed) && nextValue.trim() !== '' ? parsed : undefined)
      return
    }
    onChange(property, nextValue)
  }

  // Token-aware properties commit on blur via TokenAwareInput's `onCommit`.
  // It already returns undefined for empty input (clears the value), so
  // the only translation we do here is the number-typed coercion.
  const handleTokenCommit = (resolved: string | undefined) => {
    if (NUMBER_TYPED_PROPS.has(property)) {
      if (resolved == null || resolved === '') {
        onChange(property, undefined)
        return
      }
      const parsed = Number(resolved)
      onChange(property, Number.isFinite(parsed) ? parsed : resolved)
      return
    }
    onChange(property, resolved)
  }

  // Preview counterparts — same value coercion as the commit handlers, but
  // routed to `onPreview` so the value lands on the canvas transiently
  // (no history entry). No-op when the parent didn't wire a preview channel.
  const handleControlPreview = (_key: string, val: unknown) => {
    if (!onPreview) return
    const nextValue = String(val ?? '')
    if (NUMBER_TYPED_PROPS.has(property)) {
      const parsed = Number(nextValue)
      onPreview(property, Number.isFinite(parsed) && nextValue.trim() !== '' ? parsed : undefined)
      return
    }
    onPreview(property, nextValue)
  }

  const handleTokenPreview = (resolved: string | undefined) => {
    if (!onPreview) return
    if (NUMBER_TYPED_PROPS.has(property)) {
      if (resolved == null || resolved === '') {
        onPreview(property, undefined)
        return
      }
      const parsed = Number(resolved)
      onPreview(property, Number.isFinite(parsed) ? parsed : resolved)
      return
    }
    onPreview(property, resolved)
  }

  // ── Dispatch to the correct control ─────────────────────────────────────
  // Each control renders with its own .controlWrapper so the row is
  // visually identical to a module property row (PP-18). When the property
  // has a framework variable scale (`tokenSource`), the token-aware input
  // takes precedence over the generic text/select dispatch below.
  let control: React.ReactNode

  if (property === 'fontFamily') {
    control = (
      <FontFamilyControl
        propKey={String(property)}
        value={String(value ?? '')}
        placeholder={placeholderText}
        onChange={handleControlChange}
        label={label}
        layout={resolvedLayout}
        onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
        onClearPreview={onClearPreview}
      />
    )
  } else if (tokenSource) {
    control = (
      <ControlRow
        propKey={String(property)}
        label={label}
        layout={resolvedLayout}
      >
        <TokenAwareInput
          aria-label={label}
          value={value !== undefined ? String(value) : undefined}
          placeholder={placeholderText}
          prefix={glyphPrefix}
          tokens={tokens}
          onCommit={handleTokenCommit}
          onPreview={onPreview ? handleTokenPreview : undefined}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    )
  } else if (iconEnumOptions) {
    // The enum draws itself. No label row at all — a picture that still needs
    // a word beside it isn't doing its job, and the tooltip + `aria-label` on
    // each segment carry the name for anyone who needs it spelled out.
    // Clicking the active segment clears the property, which is the only way
    // back to "unset" once a toggle group has no empty option.
    control = (
      <ControlRow propKey={String(property)} label={label} layout={resolvedLayout}>
        <SegmentedControl
          value={value !== undefined && value !== '' ? String(value) : undefined}
          options={iconEnumOptions.map((option) => ({
            value: option.value,
            icon: option.icon ? <option.icon size={14} aria-hidden="true" /> : undefined,
            label: option.label,
            ariaLabel: `${label}: ${option.tooltip}`,
            tooltip: option.tooltip,
          }))}
          onChange={(next) => handleControlChange(String(property), next)}
          onClear={() => onRemove(property)}
          fullWidth={iconEnumOptions.some((option) => option.label != null)}
          aria-label={label}
        />
      </ControlRow>
    )
  } else if (property === 'backgroundImage') {
    // background-image gets its own multi-mode control (None / Image picker /
    // Gradient text). See BackgroundImageControl for the value-string format
    // (`url('...')` / `linear-gradient(...)` / empty) — chosen so imported
    // CSS from the Super Import pipeline lands on the right tab without any
    // post-processing. We intentionally drop the schema-level placeholder
    // (always `none` here, which is unhelpful inside the gradient input).
    control = (
      <BackgroundImageControl
        propKey={String(property)}
        value={String(value ?? '')}
        onChange={handleControlChange}
        label={label}
      />
    )
  } else switch (type) {
    case 'color':
      control = (
        <ColorControl
          key={`${String(property)}-${String(value ?? '')}`}
          propKey={String(property)}
          value={String(value ?? '')}
          placeholder={placeholderText}
          onChange={handleControlChange}
          label={label}
          layout={resolvedLayout}
          onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
          onClearPreview={onClearPreview}
        />
      )
      break

    case 'select': {
      const enumOptions = getEnumOptions(property) ?? []
      const opts = property === 'fontWeight'
        ? getFontWeightOptions(fontFamilyValue, fonts, enumOptions)
        : enumOptions
      control = (
        <SelectControl
          propKey={String(property)}
          value={String(value ?? '')}
          placeholder={placeholderText}
          onChange={handleControlChange}
          label={label}
          layout={resolvedLayout}
          options={[
            { label: '—', value: '' },
            ...opts.map((o) => ({ label: o, value: o })),
          ]}
          onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
          onClearPreview={onClearPreview}
        />
      )
      break
    }

    case 'text':
    default: {
      // Length properties (width, height, gap, insets, border widths/radii, …)
      // get arrow-key nudging with an empty-field start-from-zero. The unit
      // follows the placeholder/default value when it carries one, else px.
      const nudgeEmptyUnit = isLengthNudgeProp(property)
        ? (parseNudgeableValue(placeholderText ?? '')?.unit ?? 'px')
        : undefined
      control = (
        <TextControl
          propKey={String(property)}
          value={String(value ?? '')}
          placeholder={placeholderText}
          onChange={handleControlChange}
          label={label}
          layout={resolvedLayout}
          prefix={glyphPrefix}
          nudgeEmptyUnit={nudgeEmptyUnit}
        />
      )
      break
    }
  }

  // Track F1 — every declared source that ISN'T the winner (or every source
  // when nothing here won because of an honest `ambiguous` tie — see
  // `stylePropertyProvenance.ts`), struck through rather than hidden.
  const shadowedSources = provenance?.sources.filter((s) => !s.winner) ?? []
  const showInheritedHint = provenance?.inherited === true && !isSet

  return (
    <div
      className={cn(
        styles.propertyRowWrap,
        layout === 'stacked' && styles.propertyRowWrapStacked,
        resolvedLayout === 'bare' && styles.propertyRowWrapBare,
        !isSet && styles.propertyRowUnset,
      )}
      data-state={isSet ? 'set' : 'unset'}
      data-testid={`css-property-row-${String(property)}`}
    >
      {/* Control renders with its own .controlWrapper — identical to module rows (PP-18) */}
      {control}

      {/* Remove button: overlaid on the label column; revealed on hover/focus-within */}
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          onClick={() => onRemove(property)}
          aria-label={`Remove ${label} property`}
          tooltip={`Remove ${label}`}
          className={styles.removeBtn}
        >
          <CloseIcon size={16} color="currentColor" aria-hidden="true" />
        </Button>
      )}

      {(shadowedSources.length > 0 || showInheritedHint) && (
        <div className={styles.provenanceStrip} data-testid={`css-property-provenance-${String(property)}`}>
          {showInheritedHint && <span className={styles.provenanceInherited}>inherited</span>}
          {shadowedSources.map((source) => (
            <span
              key={`${source.kind}-${source.classId ?? 'inline'}`}
              className={styles.provenanceLoser}
              title={`${source.label}: ${source.value} — not applied here`}
            >
              <span className={styles.provenanceLoserLabel}>{source.label}</span>
              <span className={styles.provenanceLoserValue}>{String(source.value)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
