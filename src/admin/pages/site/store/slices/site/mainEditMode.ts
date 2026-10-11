/**
 * mainEditMode — the ONE explicit "edit the shared thing itself" mode.
 *
 * Two kinds of markup are shared by design and are normally protected from a
 * one-frame gesture:
 *
 *  - a component's own markup (`fromComponent`): OD-19 makes a value edit made
 *    on one instance change only that instance. "Edit main component" turns
 *    that off for one component — every instance changes
 *    (`instanceOverrideActions.ts`);
 *  - a Next `layout`/`template` file (route chrome): a structural gesture on it
 *    is refused, because it is composed into every route below it. G-8's
 *    "Edit layout (N routes)" allows the gestures on ONE layout file
 *    (`layoutEdit.ts`).
 *
 * Both are the same decision — "I mean the shared source, not this frame" —
 * so they are one mode with one target, one setter, one banner
 * (`SharedComponentNotice`, `LayoutEditChip`) and one way out ("Done"), not two
 * parallel flags. Only one target is active at a time: starting one ends the
 * other.
 */
import { setEditedLayoutFile } from '@core/page-tree'
import type { EditorStoreSetter } from './types'

/** What the user chose to edit as a whole. */
export type MainEditTarget = { kind: 'component'; name: string } | { kind: 'layout'; rel: string }

/** True while `target` is the main-edit mode of the component called `name`. */
export function isEditingComponent(target: MainEditTarget | null, name: string | undefined): boolean {
  return target?.kind === 'component' && name !== undefined && target.name === name
}

/** The layout file being edited, or `null`. */
export function editedLayoutOf(target: MainEditTarget | null): string | null {
  return target?.kind === 'layout' ? target.rel : null
}

export interface MainEditSlice {
  /** The shared thing being edited as a whole, or `null`. See this module's doc. */
  mainEditTarget: MainEditTarget | null
  /** Start (or, with `null`, end) the mode. The ONLY writer of `mainEditTarget`. */
  setMainEditTarget: (target: MainEditTarget | null) => void
}

export function createMainEditActions(set: EditorStoreSetter): Pick<MainEditSlice, 'setMainEditTarget'> {
  return {
    setMainEditTarget: (target) => {
      set((draft) => {
        draft.mainEditTarget = target
        draft.variantEditAxis = null // CV-4 — the chosen variant prop belonged to the component being edited
      })
      setEditedLayoutFile(editedLayoutOf(target))
    },
  }
}

/** A whole document replaced the open one (a project switch, a new site): the mode belonged to the old one. */
export function endMainEditMode(draft: { mainEditTarget: MainEditTarget | null }): void {
  draft.mainEditTarget = null
  setEditedLayoutFile(null)
}
