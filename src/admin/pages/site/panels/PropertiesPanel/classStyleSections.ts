/**
 * classStyleSections — the Properties panel's section registry.
 *
 * Split out of `cssControlTypes.ts`, which had grown to hold two unrelated
 * things: how a single CSS property is CONTROLLED (its control type, enum
 * options, token source, default) and how the panel is DIVIDED INTO SECTIONS.
 * They change for different reasons — adding a control type is not adding a
 * section — and together they pushed the file past the 700-line ceiling.
 *
 * This file owns the second half: the section shape, the ordered section list,
 * and the two helpers that read it. `cssControlTypes.ts` imports the list back
 * to derive which properties are "curated".
 *
 * Each section's `properties` array is load-bearing beyond layout: it drives
 * the style search, the "N set" indicator, and (post-G1) whether a
 * `collapsedWhenEmpty` section may collapse at all. A property edited by a
 * section's controls but missing from this array is invisible to all three.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import { hasStyleValue } from './styleValueUtils'
import { ArrowsScaleIcon } from 'pixel-art-icons/icons/arrows-scale'
import { PointerSolidIcon } from 'pixel-art-icons/icons/pointer-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'

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
   * Figma's Fill/Stroke/Effects list law (docs/features/inspector-disclosure.md
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
// Section order — this registry is what remains of the pre-P3 (`STATE.md`
// `panel-25`) Figma-shaped section list once Layer/Align/Measures/Layout/
// Fill/Stroke/Shadow/Blur/Text migrate out to their own `INSPECTOR_SECTIONS`
// manifest entries (`sections/index.ts`). The Transform → Animations →
// Interaction order below is what's left of
// docs/features/inspector-disclosure.md §4 G5's original Position → Size →
// Auto layout → Spacing → Appearance → Fill → Stroke → Effects →
// Typography → Animations → Interaction sequence, once Typography (P3 item
// 9) also migrated out to `TextSection.tsx`.
//
// `transform` is a NEW entry, not an original G5 member: it is
// `transform`/`transformOrigin`, relocated here from the old `effects`
// entry's own ⚙ settings popover (`EffectsSectionActions`) once Shadow (P3
// item 7) and Blur (P3 item 8) both migrated `boxShadow`/`textShadow`/
// `filter`/`backdropFilter` out and `EffectsSection.tsx` was deleted
// wholesale. Neither `transform` nor `transformOrigin` has a Penpot section
// to land in (`STATE.md` `panel-25`'s own Decisions block already names them
// as Studio-extras-bound, item 11, not yet built) — parking them here as an
// honest, ordinary `collapsedWhenEmpty` entry (rendered by this editor's own
// generic per-property fallback, `ClassPropertyRow` in `stacked` layout —
// the SAME control `StackedPropertyGrid` wrapped for the old ⚙ popover, just
// without the popover shell) keeps the capability reachable through the
// legacy `StyleSectionsEditor.tsx` path until item 11 claims it for real.
// Item 11's implementer: this is where to find it, delete this entry, and
// move `transform`/`transformOrigin` into Studio extras' own manifest
// section — do not leave both homes existing at once.
//
// The last three (Transform/Animations/Interaction) are Studio's own
// additions — Figma has no CSS-cursor/pointer-events/raw-transform concept
// in this part of its model, and its motion lives in prototyping rather than
// in the style panel at all — so all three stay at the end rather than
// displacing anything Figma-native.
// Order is read by consumers via array iteration (`StyleCategoryRail`'s rail
// buttons, `StyleSectionsEditor`'s scroll order) — changing it changes both
// at once, deliberately, since they're meant to stay in lockstep.
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
]

export const CLASS_STYLE_SECTIONS: ReadonlyArray<ClassStyleSectionDefinition> = [
  {
    // `transform`/`transformOrigin` — relocated from the old `effects`
    // entry's own ⚙ settings popover (`EffectsSectionActions`, deleted
    // alongside `EffectsSection.tsx` once Shadow + Blur both migrated — see
    // this file's own "Section order" doc above). No Penpot section claims
    // either property (`STATE.md` `panel-25`'s Decisions block) — Studio
    // extras (P3 item 11, not yet built) is the eventual home; until then
    // this ordinary `collapsedWhenEmpty` entry, rendered by
    // `StyleSectionsEditor`'s generic per-property fallback (`ClassPropertyRow`
    // in `stacked` layout, the same raw-text escape hatch the old ⚙ popover's
    // `StackedPropertyGrid` used), keeps the capability reachable rather than
    // stranding it.
    id: 'transform',
    title: 'Transform',
    icon: ArrowsScaleIcon,
    collapsedWhenEmpty: true,
    properties: ['transform', 'transformOrigin'],
  },
  {
    id: 'animations',
    title: 'Animations',
    icon: VideoSolidIcon,
    // Law 1 in full: an element with no motion costs exactly one header line.
    // This section is the most expensive one to render (it resolves keyframes
    // against the whole rule registry), so collapsing when empty is not just
    // the visual convention here — it is also what keeps that work off the
    // panel for the overwhelming majority of elements.
    collapsedWhenEmpty: true,
    properties: [
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
    ],
  },
  {
    id: 'interaction',
    title: 'Interaction',
    icon: PointerSolidIcon,
    collapsedWhenEmpty: true,
    properties: [
      'cursor',
      'pointerEvents',
      'userSelect',
      'scrollBehavior',
    ],
  },
]

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
