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
 * node), one section per PR, Penpot-ordered. `layer` (item 1) and `align`
 * (item 2) are the first two migrated, each built on a separate branch and
 * merged together here; `styles` is what remains of the old registry until
 * the next section peels off — its `order` is bumped down each time so
 * `order` always reflects the CURRENT Penpot sequence.
 */
import type { ComponentType } from 'react'
import type { SelectionModel } from '../selectionModel'
import { AlignSection } from './AlignSection'
import { StyleSectionsComposer } from './StyleSectionsComposer'
import { LayerSection } from './LayerSection'
import { MeasuresSection } from './MeasuresSection'

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
  // Align (P3 item 2) — standalone align/distribute row, only rendered when
  // the selected node's parent is a flex/grid layout with something to align.
  { id: 'align', order: 1, appliesTo: (m) => m.selectedNode != null, Component: AlignSection },
  // Measures (P3 item 3) — W/H/X/Y, rotation, radius, Hug/Fill, Constraints
  // vs. FLEX ELEMENT face. See MeasuresSection.tsx's own doc header.
  { id: 'measures', order: 2, appliesTo: (m) => m.selectedNode != null, Component: MeasuresSection },
  { id: 'styles', order: 3, appliesTo: () => true, Component: StyleSectionsComposer },
]
