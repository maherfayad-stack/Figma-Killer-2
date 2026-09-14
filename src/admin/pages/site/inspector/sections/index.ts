/**
 * INSPECTOR_SECTIONS — the section manifest `STUDIO-LIVE-CANVAS-PLAN.md`
 * §P4 names (`STATE.md` `panel-23`, Phase B item 1).
 *
 * `StyleSurface.tsx` mounts every entry via
 * `INSPECTOR_SECTIONS.filter((s) => s.appliesTo(model)).sort((a, b) => a.order
 * - b.order).map((s) => <s.Component key={s.id} />)` — that MOUNT MECHANISM is
 * what this file owes P3 (the Penpot-ordered section-by-section re-skin), so
 * growing this array is P3's entire job, never touching the shell's mount
 * logic again.
 *
 * P3 (`STATE.md` `panel-25`) is fanning `StyleSectionsEditor`'s 11 internal
 * CSS categories (Spacing/Layout/Position/Size/Typography/Appearance/Fill/
 * Interaction/Effects/Animations/Border) out into independently-manifested
 * sections with real `appliesTo` predicates (e.g. Typography only on a text
 * node), one section per PR, Penpot-ordered. `layer` (item 1), `align` (item
 * 2), `measures` (item 3), `layout` (item 4), `fill` (item 5), `stroke`
 * (item 6), `shadow` (item 7), and `blur` (item 8) are migrated; `styles` is
 * what remains of the old registry until the next section peels off — its
 * `order` is bumped down each time so `order` always reflects the CURRENT
 * Penpot sequence.
 */
import type { ComponentType } from 'react'
import type { SelectionModel } from '../selectionModel'
import { AlignSection } from './AlignSection'
import { StyleSectionsComposer } from './StyleSectionsComposer'
import { LayerSection } from './LayerSection'
import { MeasuresSection } from './MeasuresSection'
import { LayoutSection } from './LayoutSection'
import { FillSection } from './FillSection'
import { StrokeSection } from './StrokeSection'
import { ShadowSection } from './ShadowSection'
import { BlurSection } from './BlurSection'

export interface InspectorSectionDefinition {
  id: string
  order: number
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
  // tsx` split. `EffectsSection.tsx`/`EffectEditorPopover.tsx` are deleted in
  // this same PR now that both Shadow and Blur have migrated — see
  // `classStyleSections.ts`'s own doc for where `transform`/`transformOrigin`
  // (the old Effects settings ⚙, no Penpot home) relocated to.
  { id: 'blur', order: 7, appliesTo: (m) => m.selectedNode != null, Component: BlurSection },
  { id: 'styles', order: 8, appliesTo: () => true, Component: StyleSectionsComposer },
]
