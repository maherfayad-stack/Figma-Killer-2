/**
 * transplantCarryNotice - the one line the board shows when a move into another
 * frame COPIED something besides the markup that changes what the element is
 * (owner decision OD-17): the state it used, or the data it read from a list row
 * or a prop default.
 *
 * Plain constants and handlers (`how: 'copy'`) are not announced - they are the
 * same bytes and behave the same. State is: the element now has its OWN copy, so
 * the two frames change separately. Data is: the row or prop was written down as
 * a constant, so it no longer follows the list.
 *
 * An info notice with Undo, never a toast about an error - the editor did what it
 * was asked. Undo is the store's own ⌘Z, which for a transplant is the undo
 * journal's `restore`: both files back, byte for byte. It is offered only while
 * this gesture is still the newest history entry; after anything else, ⌘Z would
 * undo that instead.
 */
import { pushToast } from '@ui/components/Toast'
import type { StudioSaveResponse } from './studioSaveRequests'

type Carried = NonNullable<StudioSaveResponse['carried']>

const MAX_NAMES = 3

/**
 * The store's undo, registered by the store itself (`store.ts`) - the studio layer
 * must not import the store (it would close a cycle through every action that
 * posts a structural commit). Same shape as `editorSaveRef.ts`.
 */
export interface CarryNoticeUndo {
  /** How many entries the undo stack holds now. */
  depth: () => number
  undo: () => void
}
let storeUndo: CarryNoticeUndo | null = null

export function registerCarryNoticeUndo(handle: CarryNoticeUndo): void {
  storeUndo = handle
}

function spell(entries: Carried): string {
  const names = entries.map((entry) => (entry.as === entry.name ? entry.name : `${entry.as}`))
  const shown = names.slice(0, MAX_NAMES).join(', ')
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown
}

/** The sentence for what was carried, or `null` when nothing in it needs saying. */
export function carryNoticeTitle(carried: Carried): string | null {
  const state = carried.filter((entry) => entry.how === 'state')
  const value = carried.filter((entry) => entry.how === 'value')
  if (state.length > 0 && value.length > 0) {
    return `Copied its state (${spell(state)}) and values (${spell(value)}) into the new frame`
  }
  if (state.length > 0) return `Copied its state (${spell(state)}) - the new frame has its own copy now`
  if (value.length > 0) return `Copied the values it reads (${spell(value)}) into the new frame as constants`
  return null
}

/**
 * An info notice about a write that just landed, with an Undo that is only
 * live while this write is still the newest history entry. Read the depth NOW,
 * when the gesture's own entry is on the stack (G-10's paste reuses it).
 */
export function announceUndoableNotice(title: string, body?: string): void {
  const depth = storeUndo?.depth() ?? 0
  pushToast({
    kind: 'info',
    title,
    ...(body ? { body } : {}),
    location: 'site-editor',
    durationMs: 8000,
    action: {
      label: 'Undo',
      onSelect: () => {
        if (storeUndo && storeUndo.depth() === depth) storeUndo.undo()
      },
    },
  })
}

/** Shows the notice for `carried`, with an Undo that is only live while this write is the newest history entry. */
export function announceCarried(carried: Carried | undefined): void {
  const title = carried ? carryNoticeTitle(carried) : null
  if (title) announceUndoableNotice(title)
}
