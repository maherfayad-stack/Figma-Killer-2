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
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
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
   * Left unset on `layout` and `spacing` — Figma's always-present blocks
   * (F1, F3, F10) — which keep their controls resident even at rest.
   * (`position`/`size`/`appearance` used to be in this same "always
   * resident" group; both migrated out to `MeasuresSection.tsx` — `STATE.md`
   * `panel-25`, P3 item 3 — which has no `collapsedWhenEmpty` concept of its
   * own at all, matching Penpot's own W/H/X/Y/rotation/radius block, which
   * is never collapsible.)
   */
  collapsedWhenEmpty?: boolean
  properties: ReadonlyArray<keyof CSSPropertyBag>
}

// ---------------------------------------------------------------------------
// Section order — this registry is what remains of the pre-P3 (`STATE.md`
// `panel-25`) Figma-shaped section list once Layer/Align/Measures migrate
// out to their own `INSPECTOR_SECTIONS` manifest entries (`sections/index.ts`).
// The Layout → Spacing → Fill → Stroke → Effects → Typography → Animations →
// Interaction order below is what's left of docs/features/inspector-disclosure.md
// §4 G5's original Position → Size → Auto layout → Spacing → Appearance →
// Fill → Stroke → Effects → Typography → Animations → Interaction sequence.
// The last two (Animations/Interaction) are Studio's own additions — Figma
// has no CSS-cursor/pointer-events concept, and its motion lives in
// prototyping rather than in the style panel at all — so both stay at the
// end rather than displacing anything Figma-native.
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
]

export const CLASS_STYLE_SECTIONS: ReadonlyArray<ClassStyleSectionDefinition> = [
  {
    id: 'layout',
    title: 'Layout',
    icon: LayoutSolidIcon,
    defaultOpen: true,
    properties: [
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
      // Padding lives in the Layout cluster now (G4 / Figma F4): it is a
      // layout property of a container. Margin stays in Spacing, because it
      // is a relationship with siblings rather than a property of this box.
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
    ],
  },
  {
    id: 'spacing',
    title: 'Spacing',
    icon: RulerDimensionSolidIcon,
    defaultOpen: true,
    collapsedWhenEmpty: true,
    properties: [
      'marginTop',
      'marginRight',
      'marginBottom',
      'marginLeft',
    ],
  },
  {
    id: 'fill',
    title: 'Fill',
    icon: PaintBucketSolidIcon,
    collapsedWhenEmpty: true,
    properties: [
      // G9's completion: a text node's `color` IS its fill, and Figma shows
      // it in Fill, not in the type block. It sits first because it is the
      // topmost paint — text renders over the box's own background.
      'color',
      'backgroundColor',
      'background',
      'backgroundImage',
      // The per-layer satellites of `background-image` (G6.5). They never draw
      // a top-level row — each one is edited inside its own layer's popover —
      // but they are claimed here because this array drives the section's
      // "N set" dot and the style search, and a property claimed by no section
      // is unreachable by both.
      'backgroundSize',
      'backgroundPosition',
      'backgroundRepeat',
      'backgroundAttachment',
      'backgroundOrigin',
      'backgroundClip',
      'backgroundBlendMode',
      // The element's own replaced content, not a background layer.
      'objectFit',
      'objectPosition',
    ],
  },
  {
    id: 'border',
    title: 'Border',
    icon: BoxSolidIcon,
    collapsedWhenEmpty: true,
    // Drives the section "N set" dot + search filtering. The visual
    // BorderControl edits the per-side longhands + outline; the shorthand
    // props (border / borderTop / …) live in the section's Advanced
    // disclosure and are listed here too so a search for "border" still
    // surfaces the section. Per-corner radius moved to the `appearance`
    // section (docs/features/inspector-disclosure.md §4 G5) — `borderRadius`
    // (the shorthand) stays here in Advanced for the raw-string power case.
    properties: [
      // Per-side longhands (canonical, edited by BorderControl)
      'borderTopWidth', 'borderTopStyle', 'borderTopColor',
      'borderRightWidth', 'borderRightStyle', 'borderRightColor',
      'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
      'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
      // Outline
      'outline',
      'outlineOffset',
      // Shorthands (Advanced disclosure)
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
    ],
  },
  {
    id: 'effects',
    title: 'Effects',
    icon: SparklesSolidIcon,
    collapsedWhenEmpty: true,
    // `opacity` moved to the `appearance` section (docs/features/inspector-disclosure.md §4 G5).
    // `transition`/`animation` moved to the `animations` section below (W5-5):
    // they are motion, not effects, and a property may only be claimed by one
    // section — this array drives the "N set" count and the style search, so a
    // property listed twice would be counted twice and shown twice.
    properties: [
      'boxShadow',
      // G9's completion: a text shadow is a shadow. It was resident on
      // Typography's own rows only because Effects did not exist yet when
      // that section shipped.
      'textShadow',
      'filter',
      'backdropFilter',
      'transform',
      'transformOrigin',
    ],
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
    id: 'typography',
    title: 'Typography',
    icon: TextStartTIcon,
    collapsedWhenEmpty: true,
    properties: [
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
      // `color` moved to `fill` and `textShadow` to `effects` — G9's target
      // shape, finished once those two sections existed to receive them
      // (docs/features/inspector-disclosure.md §4 G9). A property is claimed
      // by exactly ONE section: this array drives the "N set" count and the
      // style search, so leaving either listed here as well would count it
      // twice and show it twice.
      // Reached through the section's settings popover (G9 / Figma F25-F27),
      // not as resident rows. Listed here so a style search still finds them
      // and so they count toward the section's "N set" indicator — a property
      // the user has set must never be invisible to the section that owns it.
      'textOverflow',
      'textIndent',
      'marginBlock',
      'fontVariantNumeric',
      'fontFeatureSettings',
      'hangingPunctuation',
      'fontKerning',
      'fontVariationSettings',
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
