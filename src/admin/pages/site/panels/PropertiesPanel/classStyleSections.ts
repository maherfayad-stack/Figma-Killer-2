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
import { CornerRadiusIcon } from '@ui/components/InspectorIcons'
import { hasStyleValue } from './styleValueUtils'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { MoveIcon } from 'pixel-art-icons/icons/move'
import { ProportionsSolidIcon } from 'pixel-art-icons/icons/proportions-solid'
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
   * Left unset on `position`, `size`, `layout`, `spacing` and `appearance` —
   * Figma's always-present blocks (F1, F3, F10) — which keep their controls
   * resident even at rest.
   */
  collapsedWhenEmpty?: boolean
  properties: ReadonlyArray<keyof CSSPropertyBag>
}

// ---------------------------------------------------------------------------
// Section order — WS-6.1's Figma-shaped top-to-bottom flow, extended by
// docs/features/inspector-disclosure.md §4 G5: Position → Size → Auto layout →
// Spacing → Appearance → Fill → Stroke → Effects → Typography → Animations →
// Interaction. The last two are Studio's own additions — Figma has no
// CSS-cursor/pointer-events concept, and its motion lives in prototyping
// rather than in the style panel at all — so both stay at the end rather than
// displacing anything Figma-native. Animations (W5-5) sits between them
// because it is still a statement about the ELEMENT (how it behaves over
// time), where Interaction is a statement about the pointer.
// Order is read by consumers via array iteration (`StyleCategoryRail`'s rail
// buttons, `StyleSectionsEditor`'s scroll order) — changing it changes both
// at once, deliberately, since they're meant to stay in lockstep.
// ---------------------------------------------------------------------------

export const CLASS_STYLE_SECTIONS: ReadonlyArray<ClassStyleSectionDefinition> = [
  {
    id: 'position',
    title: 'Position',
    icon: MoveIcon,
    properties: [
      'position',
      'top',
      'right',
      'bottom',
      'left',
      'zIndex',
    ],
  },
  {
    id: 'size',
    title: 'Size',
    icon: ProportionsSolidIcon,
    defaultOpen: true,
    properties: [
      'width',
      'height',
      'minWidth',
      'maxWidth',
      'minHeight',
      'maxHeight',
      'aspectRatio',
      'boxSizing',
    ],
  },
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
    id: 'appearance',
    title: 'Appearance',
    icon: CornerRadiusIcon,
    defaultOpen: true,
    properties: [
      'opacity',
      'borderTopLeftRadius',
      'borderTopRightRadius',
      'borderBottomRightRadius',
      'borderBottomLeftRadius',
      'visibility',
      'mixBlendMode',
    ],
  },
  {
    id: 'fill',
    title: 'Fill',
    icon: PaintBucketSolidIcon,
    collapsedWhenEmpty: true,
    properties: [
      'backgroundColor',
      'background',
      'backgroundImage',
      'backgroundSize',
      'backgroundPosition',
      'backgroundRepeat',
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
      'color',
      'textShadow',
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
