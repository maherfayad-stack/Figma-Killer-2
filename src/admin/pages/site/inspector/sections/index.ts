/**
 * INSPECTOR_SECTIONS — the section manifest `STUDIO-LIVE-CANVAS-PLAN.md`
 * §P4 names (`STATE.md` `panel-23`, Phase B item 1).
 *
 * `StyleSurface.tsx` mounts the DESIGN-tab entries via
 * `designPrimarySections(model)` + `designMoreSections(model)` below;
 * `PrototypePanel.tsx` mounts the PROTOTYPE-tab entries via
 * `PROTOTYPE_TAB_SECTIONS`. That MOUNT MECHANISM
 * is what this file owes P3 (the Penpot-ordered section-by-section re-skin),
 * so growing this array is P3's entire job, never touching either shell's
 * mount logic again.
 *
 * P3 (`STATE.md` `panel-25`) is complete: `StyleSectionsEditor`'s 11 internal
 * CSS categories (Spacing/Layout/Position/Size/Typography/Appearance/Fill/
 * Interaction/Effects/Animations/Border) fanned out into independently-
 * manifested sections with real `appliesTo` predicates (e.g. Typography only
 * on a text node), one section (or, for item 11, six sections) per PR,
 * Penpot-ordered. The old `styles` catch-all entry
 * (`StyleSectionsComposer.tsx`) is deleted — there is nothing left in the
 * legacy registry for it to render.
 *
 * ## `tabs` — which shells mount a section
 *
 * Every entry declares which of `InspectorShell`'s tabs it belongs to via
 * `tabs`, defaulting to `['design']` — so every entry except
 * `transform`/`animations`/`interaction` is untouched by this field.
 *
 * Those three are `['design', 'prototype']`: motion, transforms, and
 * cursor/pointer behaviour belong to the Prototype tab (Figma's own motion
 * lives in prototyping, not the style panel), and `PrototypePanel` renders
 * them there **expanded**, at rest, because that tab exists for exactly this
 * material. They ALSO stay reachable from Design — a CSS `transform` is a
 * style, and hiding it behind a tab switch would make it undiscoverable for
 * a user who never opens Prototype — but only inside the collapsed **More**
 * disclosure described below, never as always-mounted Design-tab height.
 *
 * ## `designGroup` — the 900px budget, and the one More disclosure (S5)
 *
 * `docs/features/inspector.md` §6's budget is a text node's WHOLE Design tab
 * rendering with no internal scrollbar at a 900px viewport. The four Studio-
 * extras sections — Transform, Animations, Interaction, Custom properties —
 * are what pushed it past that: none of them has a Penpot/Figma Design-tab
 * equivalent, each is genuinely rare, and together they cost a header plus
 * (for Custom properties) an always-resident "Add property" row of permanent
 * Design-tab height for material almost no selection needs.
 *
 * `designGroup: 'more'` moves an entry out of the continuous scroll and into
 * ONE collapsed `Section title="More"` that `StyleSurface.tsx` renders at the
 * very end of the Design tab. Collapsed, the four of them cost a single
 * 32px header between them instead of four headers plus their resident rows;
 * expanded, they render exactly as before, in manifest order, with no second
 * copy of any component. `designGroup` defaults to `'primary'` (the
 * continuous scroll) — every other entry relies on that default.
 *
 * The retired `attributes` entry (P3 item 11's "Attributes" section) is gone
 * for good in the same pass: `panel-29` removed it from this manifest on
 * direct user feedback and parked `AttributesSection.tsx`/`.module.css`/
 * `htmlAttributesModel.ts` unmounted "but intact", which is exactly the
 * `No dead code` rule's failure mode — three files and a test suite nothing
 * renders. They are deleted. The `htmlAttributes` PROP is untouched and
 * still read by the publisher, `htmlImport`, and every base module's own
 * renderer; only its retired editor UI is gone.
 *
 * 15 entries: 11 mount in the Design tab's continuous scroll, 4 in Design's
 * More disclosure (3 of which also mount, expanded, in Prototype).
 */
import type { ComponentType } from 'react'
import type { SelectionModel } from '../selectionModel'
import { isTextNode } from '../../panels/PropertiesPanel/styleSectionOrder'
import { AlignSection } from './AlignSection'
import { LayerSection } from './LayerSection'
import { MeasuresSection } from './MeasuresSection'
import { LayoutSection } from './LayoutSection'
import { FillSection } from './FillSection'
import { StrokeSection } from './StrokeSection'
import { ShadowSection } from './ShadowSection'
import { BlurSection } from './BlurSection'
import { TextSection } from './TextSection'
import { ExportSection } from './ExportSection'
import { ComponentSection } from './ComponentSection'
import { TransformSection } from './TransformSection'
import { AnimationsSection } from './AnimationsSection'
import { InteractionSection } from './InteractionSection'
import { CustomPropertiesSection } from './CustomPropertiesSection'

export type InspectorSectionTab = 'design' | 'prototype'

/** Design-tab residency — see this file's own `designGroup` doc. */
export type InspectorSectionDesignGroup = 'primary' | 'more'

export interface InspectorSectionDefinition {
  id: string
  order: number
  /** Which `InspectorShell` tabs mount this section. Defaults to `['design']`. */
  tabs?: ReadonlyArray<InspectorSectionTab>
  /** Where inside the Design tab it mounts. Defaults to `'primary'`. */
  designGroup?: InspectorSectionDesignGroup
  appliesTo(selection: SelectionModel): boolean
  Component: ComponentType
}

export const INSPECTOR_SECTIONS: InspectorSectionDefinition[] = [
  // Layer (P3 item 1, `STATE.md` `panel-25`) — Penpot's first, unlabeled
  // content row: opacity/blend/hide/lock. Order 0 — it renders above the
  // rest of the (not yet migrated) curated bag.
  { id: 'layer', order: 0, appliesTo: (m) => m.selectedNode != null, Component: LayerSection },
  // Align (P3 item 2) — Penpot's own standalone align/distribute row.
  { id: 'align', order: 1, appliesTo: (m) => m.selectedNode != null, Component: AlignSection },
  // Measures (P3 item 3) — W/H/X/Y, rotation, radius, Hug/Fill, Constraints
  // vs. FLEX ELEMENT face. See MeasuresSection.tsx's own doc header.
  { id: 'measures', order: 2, appliesTo: (m) => m.selectedNode != null, Component: MeasuresSection },
  // Layout (P3 item 4) — the flex/grid CONTAINER's own settings. Rendered
  // for every selected node (Fill/Stroke-style residency, per the P0
  // f1-rectangle screenshot's own collapsed-empty "LAYOUT +" row) — see
  // LayoutSection.tsx's own doc for why this section never fully hides its
  // body once mounted, unlike Penpot's literal empty convention.
  { id: 'layout', order: 3, appliesTo: (m) => m.selectedNode != null, Component: LayoutSection },
  // Fill (P3 item 5) — text colour / solid fill / background-image layers /
  // content fit, in CSS paint order. Any selected node can carry a fill
  // (matches the old `FillSection`'s own unconditional mount inside
  // `StyleSectionsEditor` — no node kind ever excluded it).
  { id: 'fill', order: 4, appliesTo: (m) => m.selectedNode != null, Component: FillSection },
  // Stroke (P3 item 6) — the `border*Width/Style/Color` longhands +
  // `outline`/`outlineOffset`, uniform colour/style fanned to all four
  // sides, per-side weight. Any selected node can carry a border (matches
  // the old `StrokeSection`'s own unconditional mount inside
  // `StyleSectionsEditor` via the `border` entry — no node kind ever
  // excluded it).
  { id: 'stroke', order: 5, appliesTo: (m) => m.selectedNode != null, Component: StrokeSection },
  // Shadow (P3 item 7) — `box-shadow` / `text-shadow` layers, split out of
  // the old `EffectsSection.tsx`. Any selected node can carry a shadow
  // (matches the old `effects` entry's own unconditional mount — no node
  // kind ever excluded it).
  { id: 'shadow', order: 6, appliesTo: (m) => m.selectedNode != null, Component: ShadowSection },
  // Blur (P3 item 8) — `filter: blur()` ("Layer blur") / `backdrop-filter:
  // blur()` ("Background blur"), the other half of the old `EffectsSection.
  // tsx` split.
  { id: 'blur', order: 7, appliesTo: (m) => m.selectedNode != null, Component: BlurSection },
  // Text (P3 item 9) — family/weight/size/line-height/letter-spacing/align/
  // vertical-align, split out of the old `typography` entry. The first
  // section in this series gated on more than "a node is selected" —
  // `isTextNode` (`styleSectionOrder.ts`, reused not duplicated) — since
  // Text only means something on a text-capable node.
  { id: 'text', order: 8, appliesTo: (m) => m.selectedNode != null && isTextNode(m.selectedNode), Component: TextSection },
  // Export (P3 item 10) — PNG/SVG of a node, Copy CSS, Copy JSX. Node-level,
  // not a set of CSS properties, so unlike every other entry here it never
  // wrote to `classStyleSections.ts` in the first place (see
  // `ExportSection.tsx`'s own doc for why).
  { id: 'export', order: 9, appliesTo: (m) => m.selectedNode != null, Component: ExportSection },
  // Component (P3 item 11, `STATE.md` `panel-25`, Studio extras) — call-site
  // props for a selected `studio.instance` node. The only one of the Studio-
  // extras entries with a node-KIND predicate, not just "a node is selected".
  { id: 'component', order: 10, appliesTo: (m) => m.selectedNode?.moduleId === 'studio.instance', Component: ComponentSection },
  // Transform (P3 item 11) — `transform`/`transformOrigin`. Expanded in
  // Prototype, behind Design's More disclosure. See the `tabs`/`designGroup`
  // docs above.
  {
    id: 'transform',
    order: 11,
    tabs: ['design', 'prototype'],
    designGroup: 'more',
    appliesTo: (m) => m.selectedNode != null,
    Component: TransformSection,
  },
  // Animations (P3 item 11) — `animation*`/`transition`.
  {
    id: 'animations',
    order: 12,
    tabs: ['design', 'prototype'],
    designGroup: 'more',
    appliesTo: (m) => m.selectedNode != null,
    Component: AnimationsSection,
  },
  // Interaction (P3 item 11) — `cursor`/`pointerEvents`/`userSelect`/
  // `scrollBehavior`.
  {
    id: 'interaction',
    order: 13,
    tabs: ['design', 'prototype'],
    designGroup: 'more',
    appliesTo: (m) => m.selectedNode != null,
    Component: InteractionSection,
  },
  // Custom properties (P3 item 11) — every uncurated key
  // (`!isCuratedProperty`), the Webflow/Framer-style escape hatch. Stays
  // LAST, now as the last row inside More rather than the last always-
  // mounted section of the Design tab: its "Add property" trigger is
  // resident even when nothing is set, which is real permanent height for
  // the rarest surface in the panel.
  {
    id: 'customProperties',
    order: 14,
    designGroup: 'more',
    appliesTo: (m) => m.selectedNode != null,
    Component: CustomPropertiesSection,
  },
]

const DEFAULT_TABS: ReadonlyArray<InspectorSectionTab> = ['design']

function mountsIn(section: InspectorSectionDefinition, tab: InspectorSectionTab): boolean {
  return (section.tabs ?? DEFAULT_TABS).includes(tab)
}

function designSections(
  selection: SelectionModel,
  group: InspectorSectionDesignGroup,
): InspectorSectionDefinition[] {
  return INSPECTOR_SECTIONS.filter(
    (section) =>
      mountsIn(section, 'design') &&
      (section.designGroup ?? 'primary') === group &&
      section.appliesTo(selection),
  ).sort((a, b) => a.order - b.order)
}

/** Design-tab sections in the continuous scroll, in manifest order. */
export function designPrimarySections(selection: SelectionModel): InspectorSectionDefinition[] {
  return designSections(selection, 'primary')
}

/** Design-tab sections inside the collapsed More disclosure, in manifest order. */
export function designMoreSections(selection: SelectionModel): InspectorSectionDefinition[] {
  return designSections(selection, 'more')
}

/**
 * Prototype-tab sections, in manifest order. No `appliesTo` filter and no
 * `SelectionModel` argument: `PrototypePanel` mounts these unconditionally
 * (each already renders `null` on no selection — their own file docs), so
 * this is a constant the panel can hold at module scope.
 */
export const PROTOTYPE_TAB_SECTIONS: ReadonlyArray<InspectorSectionDefinition> =
  INSPECTOR_SECTIONS.filter((section) => mountsIn(section, 'prototype')).sort(
    (a, b) => a.order - b.order,
  )
