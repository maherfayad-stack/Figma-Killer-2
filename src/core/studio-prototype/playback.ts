/**
 * playback — what a click does while the player is armed, and what the screen
 * stack looks like afterwards. Pure: no DOM, no store, no React.
 *
 * The player is a stack machine over two stacks:
 *
 *   - `screens`  — everything `navigate` pushed. `back` pops it.
 *   - `overlays` — everything `overlay` presented on top of the current screen.
 *                  `close` pops it, and so does `back` when one is showing,
 *                  because that is what the gesture means to someone looking at
 *                  a sheet over a screen.
 *
 * Navigating out from under an overlay drops every overlay: the overlay
 * belonged to the screen being left. Keeping it would leave a sheet floating
 * over a page it was never opened from.
 */
import type { PrototypeLink } from './types'

/**
 * The two stacks.
 *
 * Plain mutable arrays rather than `readonly`, matching every other persisted
 * or store-held shape in the codebase, because Mutative's draft type rejects a
 * readonly array and the editor store is where this lives. Nothing here ever
 * mutates one — every function below returns new arrays — so the guarantee is
 * in the implementation rather than the type.
 */
export interface PlayState {
  /** Screens pushed by `navigate`, oldest first. Empty means "the start screen". */
  screens: string[]
  /** Overlays on top of the current screen, innermost last. */
  overlays: string[]
}

/**
 * The state the player starts and resets to.
 *
 * A shared constant rather than a factory so a no-op action can return the
 * caller's own object by identity (`applyPlayAction` does), which is what lets
 * the store skip a write and a re-render. Safe to share because nothing in this
 * module or the slice ever mutates a stack in place.
 */
export const INITIAL_PLAY_STATE: PlayState = { screens: [], overlays: [] }

/**
 * The page the player is SHOWING — the top of the screen stack, or the screen
 * it started on when nothing has been pushed.
 */
export function currentScreen(state: PlayState, startPageId: string | null): string | null {
  return state.screens[state.screens.length - 1] ?? startPageId
}

/** The overlay presented on top, or `null`. */
export function currentOverlay(state: PlayState): string | null {
  return state.overlays[state.overlays.length - 1] ?? null
}

/**
 * Whether the player can go back at all. Used to decide whether a `back` link
 * is a dead end — worth saying, because a back button on the entry screen is a
 * real prototype bug and the player is where it should show up.
 */
export function canGoBack(state: PlayState): boolean {
  return state.overlays.length > 0 || state.screens.length > 0
}

/**
 * Apply a link. Returns the same object when the action changes nothing, so
 * callers can skip a state write and a re-render.
 */
export function applyPlayAction(state: PlayState, link: PrototypeLink): PlayState {
  switch (link.action) {
    case 'navigate': {
      if (!link.targetPageId) return state
      return { screens: [...state.screens, link.targetPageId], overlays: [] }
    }

    case 'overlay': {
      if (!link.targetPageId) return state
      return { ...state, overlays: [...state.overlays, link.targetPageId] }
    }

    case 'back': {
      if (state.overlays.length > 0) return { ...state, overlays: state.overlays.slice(0, -1) }
      if (state.screens.length === 0) return state
      return { ...state, screens: state.screens.slice(0, -1) }
    }

    case 'close': {
      if (state.overlays.length === 0) return state
      return { ...state, overlays: state.overlays.slice(0, -1) }
    }
  }
}

/**
 * The link a click should follow, given the clicked element and everything it
 * sits inside.
 *
 * `ancestorNodeIds` runs INNERMOST FIRST — the clicked element, then its
 * parent, and so on. Innermost wins, which is the only rule that makes a link
 * on a button inside a linked card behave the way anyone expects: you followed
 * the thing you actually clicked.
 *
 * `resolvedSourceIds` maps a link id to the node id its source hint resolves to
 * RIGHT NOW. A link whose source is `detached` has no entry and can never be
 * followed — which is why a broken link is drawn broken rather than dropped:
 * the player refusing it silently would be indistinguishable from a link that
 * was never there.
 */
export function linkForClick(
  links: readonly PrototypeLink[],
  resolvedSourceIds: ReadonlyMap<string, string>,
  ancestorNodeIds: readonly string[],
  pageId: string,
): PrototypeLink | null {
  const onPage = links.filter((link) => link.source.pageId === pageId)
  for (const nodeId of ancestorNodeIds) {
    const match = onPage.find((link) => resolvedSourceIds.get(link.id) === nodeId)
    if (match) return match
  }
  return null
}
