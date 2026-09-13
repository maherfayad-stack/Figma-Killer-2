/**
 * INSPECTOR_SECTIONS — the section manifest `STUDIO-LIVE-CANVAS-PLAN.md`
 * §P4 names (`STATE.md` `panel-23`, Phase B item 1).
 *
 * `StyleSurface.tsx` mounts every entry via
 * `INSPECTOR_SECTIONS.filter((s) => s.appliesTo(model)).sort((a, b) => a.order
 * - b.order).map((s) => <s.Component key={s.id} />)` — that MOUNT MECHANISM is
 * what this file owes P3 (the not-yet-started Penpot-ordered section-by-
 * section re-skin), so growing this array is P3's entire job, never touching
 * the shell's mount logic again.
 *
 * Deliberately ONE entry for now: fanning `StyleSectionsEditor`'s 11 internal
 * CSS categories (Spacing/Layout/Position/Size/Typography/Appearance/Fill/
 * Interaction/Effects/Animations/Border) out into independently-manifested
 * sections with real `appliesTo` predicates (e.g. Typography only on a text
 * node) is P3's job, not this one's.
 */
import type { ComponentType } from 'react'
import type { SelectionModel } from '../selectionModel'
import { StyleSectionsComposer } from './StyleSectionsComposer'

export interface InspectorSectionDefinition {
  id: string
  order: number
  appliesTo(selection: SelectionModel): boolean
  Component: ComponentType
}

export const INSPECTOR_SECTIONS: InspectorSectionDefinition[] = [
  { id: 'styles', order: 0, appliesTo: () => true, Component: StyleSectionsComposer },
]
