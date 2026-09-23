/**
 * classStyleSections — the (now-retired) Properties panel section registry.
 *
 * P3 (`STATE.md` `panel-25`) is complete as of item 11 (Studio extras):
 * every CSS category this file used to divide the panel into
 * (Spacing/Layout/Position/Size/Typography/Appearance/Fill/Interaction/
 * Effects/Animations/Border, plus the last three Studio-only additions —
 * Transform/Animations/Interaction) has migrated to its own
 * `INSPECTOR_SECTIONS` manifest entry (`src/admin/pages/site/inspector/
 * sections/index.ts`, ids `layer` through `customProperties`). This file's
 * central export, `CLASS_STYLE_SECTIONS`, is now permanently `[]` — kept
 * alive, not deleted, because two out-of-scope surfaces still import from
 * this module:
 *
 * - `StyleCategoryRail.tsx` — the ambient/global-selector rail's "one button
 *   per CSS category" loop. With `CLASS_STYLE_SECTIONS` empty, it renders no
 *   CSS-category buttons; this is a disclosed, by-construction behaviour
 *   change (see `STATE.md` `panel-25`'s Section 11 work order), not a bug —
 *   `StyleCategoryRail.tsx` itself is not touched by this migration.
 * - `cssControlTypes.ts` — imports `MIGRATED_SECTION_PROPERTIES` (below) to
 *   derive `ALL_CURATED_CSS_PROPERTIES`/`isCuratedProperty`, so every
 *   property that ever had a curated control keeps reading as curated
 *   instead of leaking into the generic Custom Properties editor.
 *
 * `ClassStyleSectionDefinition`, `getClassStyleSectionSetCounts`, and
 * `getActiveStyleTab` all stay exported for the same two callers. Do not
 * delete this file or repopulate `CLASS_STYLE_SECTIONS` — the panel's
 * section list lives in `inspector/sections/index.ts` now.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import { hasStyleValue } from './styleValueUtils'

// ---------------------------------------------------------------------------
// Class style inspector sections
//
// These sections drive the professional class editor in the Properties Panel.
// They intentionally cover every CSSPropertyBag key so class styling is an
// inspector with real controls, not a property search list.
// ---------------------------------------------------------------------------

export interface ClassStyleSectionDefinition {
  id: string
  title: string
  icon: IconComponent
  defaultOpen?: boolean
  /**
   * Figma's Fill/Stroke/Effects list law (docs/features/inspector.md
   * §1 Law 1 / §4 G1): when nothing in this section is set — on the active
   * tab OR any other breakpoint/condition — it renders as a single header
   * line with a "+", not its full property grid. `StyleSectionGroup` in
   * `StyleSectionsEditor.tsx` is what reads this flag.
   *
   * `layout`/`spacing`/`position`/`size`/`appearance`/`fill`/`border`/
   * `effects`/`typography` used to be in this registry; all nine migrated
   * out to their own `INSPECTOR_SECTIONS` manifest entries (`LayerSection`/
   * `AlignSection`/`MeasuresSection`/`LayoutSection.tsx`/`FillSection.tsx`/
   * `StrokeSection.tsx`/`ShadowSection.tsx`/`BlurSection.tsx`/
   * `TextSection.tsx` — `STATE.md` `panel-25`, P3 items 1-9). `FillSection.tsx`/
   * `StrokeSection.tsx`/`ShadowSection.tsx`/`BlurSection.tsx` keep their own
   * Law-1 empty-header/`forceOpen` disclosure locally (their own
   * `setAnywhere` check + `Section`'s `empty` prop), same as `LayerSection`/
   * `AlignSection`/`MeasuresSection`/`TextSection` — none of the nine has a
   * `collapsedWhenEmpty` concept of its own here anymore; see
   * `LayoutSection.tsx`'s own doc for why IT stays always-open instead, and
   * `TextSection.tsx`'s own doc for why a text layer has no genuinely empty
   * state to collapse to in the first place.
   */
  collapsedWhenEmpty?: boolean
  properties: ReadonlyArray<keyof CSSPropertyBag>
}

// ---------------------------------------------------------------------------
// Section order — P3 is complete. `Transform`/`Animations`/`Interaction`,
// this registry's last three entries, migrated to their own
// `INSPECTOR_SECTIONS` manifest entries (`TransformSection.tsx`/
// `AnimationsSection.tsx`/`InteractionSection.tsx` under `inspector/
// sections/`) in P3 item 11 (`STATE.md` `panel-25`), the same way every
// other CSS category migrated out in items 1-9. `CLASS_STYLE_SECTIONS` is
// now permanently `[]` — see this file's own top-of-file doc for who still
// reads it and why it isn't deleted.
// ---------------------------------------------------------------------------

/**
 * Properties claimed by a P3 (`STATE.md` `panel-25`) manifest section that
 * has migrated OUT of this legacy registry entirely — not folded into any
 * `ClassStyleSectionDefinition` here, because `StyleSectionsEditor`'s
 * generic per-property fallback (its final `section.properties.map(...)`
 * branch) would then render a SECOND, uncoordinated copy of the same
 * property next to the new section's own control — exactly the "two
 * components racing to write opacity" hazard Layer's own design flags.
 *
 * `isCuratedProperty`/`ALL_CURATED_CSS_PROPERTIES` (`cssControlTypes.ts`)
 * still need these keys "claimed" — so they stay out of the generic Custom
 * Properties editor, and so `useFrameComputedStyleValues` still fetches
 * their real computed value for the new section's own prefill — so they are
 * unioned in there, without ever being iterated by
 * `getVisibleStyleSections`/`getClassStyleSectionSetCounts`.
 */
export const MIGRATED_SECTION_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  // Layer (P3 item 1) — src/admin/pages/site/inspector/sections/LayerSection.tsx
  'opacity',
  'mixBlendMode',
  'visibility',
  // Measures (P3 item 3) — src/admin/pages/site/inspector/sections/MeasuresSection.tsx.
  // Absorbs the old `position` + `size` + `appearance` (radius-only remainder)
  // entries wholesale — every property those three used to claim, unioned
  // here in one step rather than split by their old section identity, since
  // Measures is now the SINGLE section rendering all of them.
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'zIndex',
  'rotate',
  'scale',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'aspectRatio',
  'boxSizing',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
  // Layout (P3 item 4) — src/admin/pages/site/inspector/sections/LayoutSection.tsx.
  // Absorbs the old `layout` + `spacing` entries wholesale, unioned here in
  // one step, same pattern Measures established for `position`/`size`/
  // `appearance`. `alignSelf`/`justifySelf` are credited to Align (item 2,
  // `AlignSection.tsx`), which claimed sole ownership of them once Layout's
  // own `LayoutSettingsButton` dropped its (now-duplicate) copy — see that
  // file's own doc for why. `gap` stays claimed even though no resident
  // Layout field writes it directly anymore (superseded by the `rowGap`/
  // `columnGap` split, `GapRow.tsx`'s own doc) — a value set from raw source
  // must still read as curated, not leak into Custom Properties.
  'display',
  'flexDirection',
  'flexWrap',
  'alignItems',
  'justifyContent',
  'justifyItems',
  'alignSelf',
  'justifySelf',
  'flex',
  'gap',
  'rowGap',
  'columnGap',
  'gridTemplateColumns',
  'gridTemplateRows',
  'gridColumn',
  'gridRow',
  'overflow',
  'overflowX',
  'overflowY',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  // Fill (P3 item 5) — src/admin/pages/site/inspector/sections/FillSection.tsx.
  // Text colour / solid fill / background-image layers (+ its six per-layer
  // satellites, none of which ever drew a top-level row even in the old
  // registry) / content fit, unioned here in one step, same pattern
  // Measures/Layout established.
  'color',
  'backgroundColor',
  'background',
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundAttachment',
  'backgroundOrigin',
  'backgroundClip',
  'backgroundBlendMode',
  'objectFit',
  'objectPosition',
  // Stroke (P3 item 6) — src/admin/pages/site/inspector/sections/StrokeSection.tsx.
  // The per-side `border*Width/Style/Color` longhands (colour/style fanned
  // to all four sides, weight per-side), `outline`/`outlineOffset`, and the
  // raw shorthand escape hatches (reachable via Stroke's own ⚙ settings
  // popover, `StackedPropertyGrid` — Law 2 turns an in-panel disclosure into
  // a popover, it does not delete the capability behind it) — every property
  // the old `border` entry used to claim, unioned here in one step, same
  // pattern every migrated section established.
  'borderTopWidth',
  'borderTopStyle',
  'borderTopColor',
  'borderRightWidth',
  'borderRightStyle',
  'borderRightColor',
  'borderBottomWidth',
  'borderBottomStyle',
  'borderBottomColor',
  'borderLeftWidth',
  'borderLeftStyle',
  'borderLeftColor',
  'outline',
  'outlineOffset',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'appearance',
  // Shadow (P3 item 7) — src/admin/pages/site/inspector/sections/ShadowSection.tsx.
  // Text shadow moved onto the same section as box shadow in G9's completion
  // (a text shadow is a shadow) — unioned here in one step, same pattern
  // every migrated section established.
  'boxShadow',
  'textShadow',
  // Blur (P3 item 8) — src/admin/pages/site/inspector/sections/BlurSection.tsx.
  // `filter: blur()` ("Layer blur") + `backdrop-filter: blur()` ("Background
  // blur") — the other half of the old `effects` entry's claim.
  'filter',
  'backdropFilter',
  // Text (P3 item 9) — src/admin/pages/site/inspector/sections/TextSection.tsx.
  // Every property the old `typography` entry claimed, unioned here in one
  // step, same pattern every migrated section established. `color`/
  // `textShadow` stay claimed by Fill/Shadow (G9.4, W8-1) — this section
  // doesn't touch either. `alignItems` (the vertical-align convenience
  // write TextSection's own doc describes) stays credited to Layout below,
  // NOT unioned here — a property is claimed by exactly one section.
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textDecoration',
  'textTransform',
  'whiteSpace',
  'textOverflow',
  'textIndent',
  'marginBlock',
  'fontVariantNumeric',
  'fontFeatureSettings',
  'hangingPunctuation',
  'fontKerning',
  'fontVariationSettings',
  // Transform (P3 item 11) — src/admin/pages/site/inspector/sections/TransformSection.tsx.
  'transform',
  'transformOrigin',
  // Animations (P3 item 11) — src/admin/pages/site/inspector/sections/AnimationsSection.tsx.
  'animation',
  'animationName',
  'animationDuration',
  'animationTimingFunction',
  'animationDelay',
  'animationIterationCount',
  'animationDirection',
  'animationFillMode',
  'animationPlayState',
  'transition',
  // Interaction (P3 item 11) — src/admin/pages/site/inspector/sections/InteractionSection.tsx.
  'cursor',
  'pointerEvents',
  'userSelect',
  'scrollBehavior',
]

/**
 * P3 is complete — every CSS category this registry used to divide the panel
 * into has migrated to its own `INSPECTOR_SECTIONS` manifest entry. This
 * array is permanently empty; see this file's own top-of-file doc for why it
 * still exists.
 */
export const CLASS_STYLE_SECTIONS: ReadonlyArray<ClassStyleSectionDefinition> = []

// ---------------------------------------------------------------------------
// Style tab utilities
//
// Shared by StyleRuleComposer, StyleSurface, and PropertiesPanel. Kept here (not
// in StyleRuleComposer) so StyleRuleComposer stays a components-only file —
// satisfying the react-refresh/only-export-components lint rule.
// ---------------------------------------------------------------------------

/**
 * Returns a map from section id → number of properties with stored values.
 * Used to render the set-style dot badges on the StyleCategoryRail.
 */
export function getClassStyleSectionSetCounts(
  storedStyles: Record<string, unknown>,
): ReadonlyMap<string, number> {
  return new Map(
    CLASS_STYLE_SECTIONS.map((section) => [
      section.id,
      section.properties.filter((prop) => hasStyleValue(storedStyles[prop])).length,
    ]),
  )
}

/**
 * Returns the active breakpoint tab id for class style reads/writes.
 * 'base' when desktop (or no breakpoint); otherwise the breakpoint id.
 */
export function getActiveStyleTab(activeBreakpointId: string | undefined): string {
  return activeBreakpointId && activeBreakpointId !== 'desktop' ? activeBreakpointId : 'base'
}
