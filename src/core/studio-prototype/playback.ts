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
import { actionTakesTarget, type PrototypeLink, type PrototypeTransition, type PrototypeTriggerKind } from './types'

/**
 * The two stacks.
 *
 * Plain mutable arrays rather than `readonly`, matching every other persisted
 * or store-held shape in the codebase, because Mutative's draft type rejects a
 * readonly array and the editor store is where this lives. Nothing here ever
 * mutates one — every function below returns new arrays — so the guarantee is
 * in the implementation rather than the type.
 */
/**
 * One entry on either stack: what is showing, and HOW IT ARRIVED.
 *
 * The transition is remembered because `back` has none of its own — going back
 * means reversing whatever brought you here, and once an action has been
 * applied a bare stack of page ids no longer says what that was. Without it a
 * pop is an instant cut sitting next to a 420ms push, which reads as a bug.
 */
export interface PlayEntry {
  pageId: string
  transition: PrototypeTransition
}

export interface PlayState {
  /** Screens pushed by `navigate`, oldest first. Empty means "the start screen". */
  screens: PlayEntry[]
  /** Overlays on top of the current screen, innermost last. */
  overlays: PlayEntry[]
}

/**
 * What a completed action should animate.
 *
 * `entering` plays on whatever is arriving; `leaving` on whatever is going
 * away, which only a `back` or a `close` has. Both `null` means nothing moved.
 */
export interface PlayOutcome {
  state: PlayState
  entering: PrototypeTransition | null
  leaving: PrototypeTransition | null
}

/**
 * The transition that undoes `transition`.
 *
 * A leftward push is undone by a rightward one — that is what makes a pop feel
 * like the reverse of the push, rather than a second push in the same
 * direction. Everything symmetrical (a dissolve, a sheet, a popup) undoes
 * itself: the direction is already implied by which way it is played.
 */
export function reverseTransition(transition: PrototypeTransition): PrototypeTransition {
  switch (transition) {
    case 'slide-left':
      return 'slide-right'
    case 'slide-right':
      return 'slide-left'
    case 'push-left':
      return 'push-right'
    case 'push-right':
      return 'push-left'
    default:
      return transition
  }
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
  return state.screens[state.screens.length - 1]?.pageId ?? startPageId
}

/** The overlay presented on top, or `null`. */
export function currentOverlay(state: PlayState): string | null {
  return state.overlays[state.overlays.length - 1]?.pageId ?? null
}

/**
 * Whether the player can go back at all. Used to decide whether a `back` link
 * is a dead end — worth saying, because a back button on the entry screen is a
 * real prototype bug and the player is where it should show up.
 */
export function canGoBack(state: PlayState): boolean {
  return state.overlays.length > 0 || state.screens.length > 0
}

/** A copy that shares nothing with `entry` — see `applyPlayAction`. */
function cloneEntry(entry: PlayEntry): PlayEntry {
  return { pageId: entry.pageId, transition: entry.transition }
}

/**
 * Apply a link. Returns the SAME state object when the action changes nothing,
 * so callers can skip a write and a re-render.
 *
 * A changed state ALIASES NOTHING from the one passed in — every entry is
 * copied, and no array or object from the input is reused. That costs a few
 * allocations per click and buys the only thing that makes this function safe
 * to call from the editor store: the store hands it a Mutative DRAFT, and an
 * object assigned back into a draft while still holding references INTO that
 * same draft does not survive finalization. The symptom is precise and awful —
 * the scalars written beside it stick, the stack silently does not, and the
 * player shows a sheet that will not close. A pure function over plain data
 * should not hand back pieces of its argument anyway.
 */
export function applyPlayAction(state: PlayState, link: PrototypeLink): PlayOutcome {
  const unchanged: PlayOutcome = { state, entering: null, leaving: null }
  // `transition` is absent on a `back`/`close` and repaired to a legal value
  // for everything else, so the fallback only ever applies to a hand-edited
  // file that dropped it. `instant` is the honest reading of "not specified".
  const transition = link.transition ?? 'instant'

  switch (link.action) {
    case 'navigate': {
      if (!link.targetPageId) return unchanged
      return {
        state: {
          screens: [...state.screens.map(cloneEntry), { pageId: link.targetPageId, transition }],
          // Navigating out from under an overlay drops every overlay: it
          // belonged to the screen being left.
          overlays: [],
        },
        entering: transition,
        leaving: null,
      }
    }

    case 'overlay': {
      if (!link.targetPageId) return unchanged
      return {
        state: {
          screens: state.screens.map(cloneEntry),
          overlays: [...state.overlays.map(cloneEntry), { pageId: link.targetPageId, transition }],
        },
        entering: transition,
        leaving: null,
      }
    }

    // `back` closes an overlay before it pops a screen — that is what the
    // gesture means to someone looking at a sheet over a screen.
    case 'back':
    case 'close': {
      const overlay = state.overlays[state.overlays.length - 1]
      if (overlay) {
        return {
          state: {
            screens: state.screens.map(cloneEntry),
            overlays: state.overlays.slice(0, -1).map(cloneEntry),
          },
          entering: null,
          leaving: overlay.transition,
        }
      }
      // `close` is only ever about an overlay. With none showing it is a no-op,
      // where `back` goes on to pop the screen stack.
      if (link.action === 'close') return unchanged
      const screen = state.screens[state.screens.length - 1]
      if (!screen) return unchanged
      return {
        state: {
          screens: state.screens.slice(0, -1).map(cloneEntry),
          overlays: state.overlays.map(cloneEntry),
        },
        entering: reverseTransition(screen.transition),
        leaving: null,
      }
    }
  }
}

/**
 * The link a GESTURE on an element should follow, given the element and
 * everything it sits inside.
 *
 * `ancestorNodeIds` runs INNERMOST FIRST — the touched element, then its
 * parent, and so on. Innermost wins, which is the only rule that makes a link
 * on a button inside a linked card behave the way anyone expects: you followed
 * the thing you actually touched.
 *
 * `triggerKind` is matched EXACTLY, and that is what lets one element carry a
 * hover link and a click link at once. It also means a click never falls back
 * to "well, there was a hover link here": two triggers on one element are two
 * statements the user made separately, and collapsing them would fire the wrong
 * one on the gesture the other was for.
 *
 * `resolvedSourceIds` maps a link id to the node id its source hint resolves to
 * RIGHT NOW. A link whose source is `detached` has no entry and can never be
 * followed — which is why a broken link is drawn broken rather than dropped:
 * the player refusing it silently would be indistinguishable from a link that
 * was never there.
 */
export function linkForTrigger(
  links: readonly PrototypeLink[],
  resolvedSourceIds: ReadonlyMap<string, string>,
  ancestorNodeIds: readonly string[],
  pageId: string,
  triggerKind: PrototypeTriggerKind,
): PrototypeLink | null {
  const onPage = links.filter(
    (link) => link.source.pageId === pageId && link.trigger.kind === triggerKind,
  )
  for (const nodeId of ancestorNodeIds) {
    const match = onPage.find((link) => resolvedSourceIds.get(link.id) === nodeId)
    if (match) return match
  }
  return null
}

/**
 * The link a keystroke follows on the screen currently showing.
 *
 * NOT anchored to the pointer, unlike every other trigger: a keystroke lands
 * wherever focus is, which in a live frame is usually nothing in particular. So
 * the whole screen is the scope, and the FIRST live match wins — a screen with
 * two links on the same key is an authoring mistake, and picking the first is
 * at least stable between runs.
 *
 * Matching is case-insensitive because `KeyboardEvent.key` reports the SHIFTED
 * character: a link authored on `k` would otherwise stop working the moment
 * caps lock was on, which is not a distinction anybody meant to draw.
 */
export function linkForKey(
  links: readonly PrototypeLink[],
  resolvedSourceIds: ReadonlyMap<string, string>,
  pageId: string,
  key: string,
): PrototypeLink | null {
  const wanted = key.toLowerCase()
  return (
    links.find(
      (link) =>
        link.source.pageId === pageId &&
        link.trigger.kind === 'key' &&
        link.trigger.key.toLowerCase() === wanted &&
        resolvedSourceIds.has(link.id),
    ) ?? null
  )
}

/**
 * A timer the player owes a screen: the link to follow, and how long after the
 * screen arrived to follow it.
 */
export interface PendingDelayTrigger {
  link: PrototypeLink
  ms: number
}

/**
 * Every `after-delay` link that arriving on `pageId` starts.
 *
 * A TIMER IS A SIDE EFFECT, SO THIS FUNCTION DOES NOT OWN ONE. It answers what
 * the screen owes and nothing else; the caller schedules and cancels. That is
 * what keeps this module pure and unit-testable without fake timers, and it is
 * the same split `applyPlayAction` already makes with the store: the rules are
 * here, the effects are at the edge.
 */
export function delayTriggersForScreen(
  links: readonly PrototypeLink[],
  resolvedSourceIds: ReadonlyMap<string, string>,
  pageId: string,
): PendingDelayTrigger[] {
  const pending: PendingDelayTrigger[] = []
  for (const link of links) {
    if (link.source.pageId !== pageId) continue
    if (link.trigger.kind !== 'after-delay') continue
    if (!resolvedSourceIds.has(link.id)) continue
    pending.push({ link, ms: link.trigger.ms })
  }
  return pending
}

/**
 * What letting go of a `press` link undoes, as a link the machine can apply —
 * or `null` when the release means nothing.
 *
 * Expressed as a synthetic `PrototypeLink` rather than a new action verb so
 * `applyPlayAction` stays the single place that knows what pops what. The
 * reverse of a `navigate` is a `back` and the reverse of an `overlay` is a
 * `close`; a link that was ALREADY a back or a close has nothing to undo, and
 * neither does a press the user chose not to make reversible.
 *
 * The synthetic link keeps the original's id: nothing persists it, and the id
 * is what the caller uses to tell "this release belongs to that press" from
 * "some other link".
 */
export function releaseActionFor(link: PrototypeLink): PrototypeLink | null {
  if (link.trigger.kind !== 'press' || !link.trigger.reverseOnRelease) return null
  if (!actionTakesTarget(link.action)) return null
  return {
    ...link,
    action: link.action === 'overlay' ? 'close' : 'back',
    targetPageId: null,
    transition: undefined,
  }
}
