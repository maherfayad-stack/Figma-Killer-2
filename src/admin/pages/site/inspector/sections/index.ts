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
 * Fanning `StyleSectionsEditor`'s 11 internal CSS categories (Spacing/
 * Layout/Position/Size/Typography/Appearance/Fill/Interaction/Effects/
 * Animations/Border) out into independently-manifested Penpot sections is
 * P3's job (`STATE.md` `panel-25`), one section per PR. `align` (item 2 of
 * that entry's mapping table) is the second to migrate out of `styles` — the
 * `layer` entry (item 1, PR #101 on a separate branch at the time this
 * landed) is not yet in this array; see that entry's own "Done so far" for
 * why the two were built independently. `order` values get renumbered at
 * whatever point the two branches converge — see this array's own ordering
 * convention below.
 */
import type { ComponentType } from 'react'
import type { SelectionModel } from '../selectionModel'
import { AlignSection } from './AlignSection'
import { StyleSectionsComposer } from './StyleSectionsComposer'

export interface InspectorSectionDefinition {
  id: string
  order: number
  appliesTo(selection: SelectionModel): boolean
  Component: ComponentType
}

export const INSPECTOR_SECTIONS: InspectorSectionDefinition[] = [
  // `styles` keeps bumping its own `order` by one as each Penpot section
  // peels off — the same convention `panel-25`'s Layer PR established.
  { id: 'align', order: 0, appliesTo: (m) => m.selectedNode != null, Component: AlignSection },
  { id: 'styles', order: 1, appliesTo: () => true, Component: StyleSectionsComposer },
]
