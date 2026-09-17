/**
 * LayerSection — Penpot's Layer section: the FIRST content row of the
 * Design tab, unlabeled (`STATE.md` `panel-25`, item 1 of the P3 mapping
 * table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3).
 *
 * `02-measurements.md`'s own Y-origin sequence puts the opacity/blend row at
 * `y=132`, directly below the tab strip with no section header text above
 * it — the panel's very first row, always resident, never collapsible.
 *
 * ## What this claims
 *
 *   - `opacity`, `mixBlendMode` — split out of the old `AppearanceSection`
 *     (`AppearanceSectionActions`' droplet + the section body's opacity
 *     cell). `AppearanceSection.tsx` keeps only its corner-radius cluster
 *     until Measures (item 3 of the P3 mapping table) claims it.
 *   - `visibility` (CSS) — the secondary, de-emphasized toggle in this same
 *     row. See "Two different hides" below.
 *   - `node.hidden` / `node.locked` — structural facts with NO CSS
 *     equivalent, surfaced here for the first time (see "Two different
 *     hides" and "The lock icon" below).
 *
 * ## Two different hides
 *
 * The PRIMARY eye writes `toggleNodeHidden` — Penpot's real semantics,
 * removing the node from the page entirely. A SECONDARY, visually
 * de-emphasized eye (rule 3 — "rare options live in a popover on the field
 * they modify") writes CSS `visibility: hidden`, which keeps the element's
 * box in flow with its contents invisible. Both are kept, both stay
 * reachable, and their tooltips say which is which so the two "hides" are
 * never confused for one feature — `AppearanceSection.tsx`'s own doc
 * insisted on exactly this distinction before this section existed to
 * inherit it.
 *
 * ## The lock icon
 *
 * `toggleNodeLocked` had ZERO existing UI call sites anywhere in the admin
 * before this section (`toggleNodeHidden` already had one, in
 * `LayerNodeContextMenu.tsx`) — this is genuinely new surface, not a
 * re-skin. `pixel-art-icons` has no unlocked/open counterpart to
 * `lock-solid`, so `UnlockedIcon` is hand-drawn in
 * `@ui/components/InspectorIcons`, the same precedent `panel-22` set for
 * the missing `flexWrap` glyph.
 *
 * ## Reading opacity as a percentage
 *
 * Penpot's own inspector shows opacity as `0–100%`, not CSS's native `0–1`
 * float — and modern CSS accepts a `<percentage>` for `opacity` directly
 * (`opacity: 50%` and `opacity: 0.5` compute identically), so this field can
 * commit the percentage string as-is with no back-conversion. The one thing
 * that DOES need converting is anything already expressed as a bare 0–1
 * number — a value written before this section existed, or a real
 * `getComputedStyle` reading (browsers always report `opacity` as a bare
 * float) — `toPercentString` below normalizes both onto the same `%` scale
 * before the one display rule (`resolveStyleFieldDisplay`) ever sees them,
 * so an inherited `0.5` reads "50%", not the lie "0.5%".
 *
 * ## Locked (code-valued) properties
 *
 * `opacity`/`mixBlendMode` set from an expression in code are refused by
 * `commitApi.ts`'s own `lockedPropertySet` gate already — silently, at the
 * store boundary. This section ALSO disables the specific field client-side
 * (never the whole row) with a lock icon + tooltip, the same fact
 * `StyleSectionsComposer.tsx`'s banner states for the whole curated bag,
 * scoped down to just the two properties this section owns.
 *
 * ## Multi-select
 *
 * Three CSS fields, three Mixed states (`docs/features/inspector.md` §9.3):
 * `opacity` reads "Mixed" in its `ScrubInput` (via `toPercentString`, which
 * passes the sentinel through so `resolveStyleFieldDisplay` can see it), the
 * blend trigger says "Blend mode: Mixed" and its menu claims no option, and
 * the CSS-visibility toggle names the disagreement in its label. The toggle
 * gets no indeterminate glyph — the same call §9.3 makes for `AlignGrid` and
 * Clip content — and clicking it hides every selected layer.
 *
 * `node.hidden` / `node.locked` are NOT multi-select aware: both buttons read
 * and toggle the ANCHOR only. That is a structural fan-out gap, not a Mixed
 * one (it needs a store action over N ids, the way `setNodesInlineStyles` is
 * for styles), and it is recorded in `STATE.md` `panel-38`.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { resolveStyleFieldDisplay } from '../../panels/PropertiesPanel/styleFieldDisplay'
import { readString } from '../../panels/PropertiesPanel/styleValueUtils'
import { isMixed, MIXED, MIXED_PLACEHOLDER, type Mixed } from '@ui/components/MixedValue'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { OpacityIcon, UnlockedIcon } from '@ui/components/InspectorIcons'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import styles from './LayerSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []
const LAYER_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = ['opacity', 'mixBlendMode', 'visibility']

/** Figma's F12 grouped droplet menu — ported verbatim from `AppearanceSection.tsx`. */
const BLEND_MODE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['normal'],
  ['darken', 'multiply', 'color-burn'],
  ['lighten', 'screen', 'color-dodge'],
  ['overlay', 'soft-light', 'hard-light'],
  ['difference', 'exclusion'],
  ['hue', 'saturation', 'color', 'luminosity'],
]

/** Ported verbatim from `AppearanceSection.tsx`. */
function blendModeLabel(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * See this file's own "Reading opacity as a percentage" doc.
 *
 * The `MIXED` sentinel passes through UNTOUCHED and first: it is a Symbol, so
 * every branch below would have collapsed it to `undefined`, and
 * `resolveStyleFieldDisplay`'s own mixed test — which this value feeds — would
 * then never fire. Five layers at five opacities read "100%" (the fallback),
 * one keystroke from becoming one opacity (`docs/features/inspector.md` §9.3).
 */
function toPercentString(value: unknown): string | Mixed | undefined {
  if (isMixed(value)) return MIXED
  if (typeof value === 'number') return `${Math.round(value * 100)}%`
  if (typeof value !== 'string' || value === '') return undefined
  const trimmed = value.trim()
  if (trimmed.endsWith('%')) return trimmed
  const asNumber = Number(trimmed)
  return Number.isNaN(asNumber) ? undefined : `${Math.round(asNumber * 100)}%`
}

export function LayerSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const toggleNodeHidden = useEditorStore((s) => s.toggleNodeHidden)
  const toggleNodeLocked = useEditorStore((s) => s.toggleNodeLocked)
  const canEditStructure = useEditorPermissions().canEditStructure

  const [blendMenuOpen, setBlendMenuOpen] = useState(false)
  const blendTriggerRef = useRef<HTMLButtonElement>(null)

  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues } = model

  if (!selectedNodeId || !selectedNode) return null

  const isHidden = selectedNode.hidden === true
  const isLocked = selectedNode.locked === true

  // The same per-property code lock `StyleSectionsComposer.tsx`'s own
  // banner reads — ported verbatim, scoped to this section's two CSS
  // properties (see this file's own doc).
  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )
  const opacityLocked = lockedProperties.has('opacity')
  const blendLocked = lockedProperties.has('mixBlendMode')

  // The same collapsed-bag pair every other section builds from
  // (`collapsedStyleBag.ts`), scoped to Layer's own three claimed
  // properties instead of the whole curated set — single-node only
  // (`SelectionModel`'s own doc: multi-select stays out of scope).
  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(LAYER_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  const opacityDisplay = resolveStyleFieldDisplay({
    storedValue: toPercentString(storedStyles.opacity),
    currentValue: toPercentString(currentStyles.opacity),
    fallback: '100%',
  })

  // Both read the RAW cell first: `readString` collapses the `MIXED` Symbol to
  // `undefined`, which read as "nobody set a blend mode" / "nothing is hidden"
  // for a selection that plainly disagreed (§9.3).
  const blendMixed = isMixed(storedStyles.mixBlendMode)
  const blendValue = readString(storedStyles, 'mixBlendMode')
  const blendActive = blendValue != null && blendValue !== 'normal'
  const blendLabel = blendMixed
    ? `Blend mode: ${MIXED_PLACEHOLDER}`
    : blendValue
      ? `Blend mode: ${blendModeLabel(blendValue)}`
      : 'Blend mode'

  const visibilityMixed = isMixed(storedStyles.visibility)
  const isCssHidden = !visibilityMixed && readString(storedStyles, 'visibility') === 'hidden'
  // The toggle has no indeterminate affordance (the same reason §9.3 leaves
  // `AlignGrid` and Clip content unset), so a mixed selection shows it
  // unpressed and says so in words. Clicking it hides every selected layer,
  // which is the Figma contract for a mixed field: the first edit agrees them.
  const cssVisibilityLabel = visibilityMixed
    ? `Hide with CSS (keeps its space) — currently ${MIXED_PLACEHOLDER}`
    : isCssHidden
      ? 'Show (CSS visibility)'
      : 'Hide with CSS (keeps its space)'

  return (
    <div className={styles.layerRow} data-testid="inspector-layer-row">
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        pressed={isHidden}
        aria-label={isHidden ? 'Show on canvas' : 'Hide on canvas'}
        tooltip={isHidden ? 'Show on canvas' : 'Hide on canvas'}
        data-testid="layer-visibility-toggle"
        onClick={() => toggleNodeHidden(selectedNodeId)}
      >
        {isHidden ? (
          <EyeOffSolidIcon size={14} aria-hidden="true" />
        ) : (
          <EyeSolidIcon size={14} aria-hidden="true" />
        )}
      </Button>
      {canEditStructure && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          pressed={isLocked}
          aria-label={isLocked ? 'Unlock element' : 'Lock element'}
          tooltip={isLocked ? 'Unlock element' : 'Lock element'}
          data-testid="layer-lock-toggle"
          onClick={() => toggleNodeLocked(selectedNodeId)}
        >
          {isLocked ? (
            <LockSolidIcon size={14} aria-hidden="true" />
          ) : (
            <UnlockedIcon size={14} aria-hidden="true" />
          )}
        </Button>
      )}
      <Tooltip content="Opacity is set from an expression in code" disabled={!opacityLocked}>
        <span className={styles.opacityField}>
          <ScrubInput
            fieldSize="sm"
            label={<OpacityIcon size={13} aria-hidden="true" />}
            aria-label="Opacity"
            value={opacityDisplay.value}
            placeholder={opacityDisplay.placeholder}
            inherited={opacityDisplay.inherited}
            unit="%"
            min={0}
            max={100}
            disabled={opacityLocked}
            data-testid="layer-opacity"
            onChange={(next) => commit.commitStyle('opacity', next || null)}
            onPreview={(next) => commit.commitStyle('opacity', next || null, { preview: true })}
            onClearPreview={commit.clearStylePreview}
          />
          {opacityLocked && (
            <LockSolidIcon size={10} className={styles.lockBadge} aria-hidden="true" />
          )}
        </span>
      </Tooltip>
      <Button
        ref={blendTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        active={blendActive}
        disabled={blendLocked}
        aria-haspopup="menu"
        aria-expanded={blendMenuOpen}
        aria-label={blendLabel}
        tooltip={blendLocked ? 'Blend mode is set from an expression in code' : blendLabel}
        data-testid="layer-blend-mode-trigger"
        onClick={() => setBlendMenuOpen((v) => !v)}
      >
        <ColorsSwatchSolidIcon size={14} aria-hidden="true" />
      </Button>
      {blendMenuOpen && (
        <ContextMenu
          anchorRef={blendTriggerRef}
          triggerRef={blendTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          ariaLabel="Blend mode"
          onClose={() => setBlendMenuOpen(false)}
        >
          {BLEND_MODE_GROUPS.flatMap((group, groupIndex) => [
            groupIndex > 0 && <ContextMenuSeparator key={`sep-${group[0]}`} />,
            ...group.map((mode) => (
              <ContextMenuItem
                key={mode}
                // Mixed claims NO option — `normal` is not the shared answer.
                selected={blendMixed ? false : (blendValue ?? 'normal') === mode}
                onClick={() => {
                  commit.commitStyle('mixBlendMode', mode === 'normal' ? null : mode)
                  setBlendMenuOpen(false)
                }}
              >
                {blendModeLabel(mode)}
              </ContextMenuItem>
            )),
          ])}
        </ContextMenu>
      )}
      {/* Secondary CSS `visibility` toggle — see this file's own "Two
          different hides" doc. Smaller and visually de-emphasized (rule 3). */}
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        pressed={isCssHidden}
        aria-label={cssVisibilityLabel}
        tooltip={cssVisibilityLabel}
        data-testid="layer-css-visibility-toggle"
        className={styles.cssVisibilityToggle}
        onClick={() => commit.commitStyle('visibility', isCssHidden ? null : 'hidden')}
      >
        {isCssHidden ? (
          <EyeOffSolidIcon size={11} aria-hidden="true" />
        ) : (
          <EyeSolidIcon size={11} aria-hidden="true" />
        )}
      </Button>
    </div>
  )
}
