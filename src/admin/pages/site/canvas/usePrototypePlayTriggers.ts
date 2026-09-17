/**
 * usePrototypePlayTriggers — the two prototype triggers that no pointer
 * gesture on a node can deliver: `after-delay` and `key`.
 *
 * `click`, `hover` and `press` all arrive as events ON an element, so
 * `useCanvasNodeInteraction` owns them — it already has the node under the
 * pointer, which is the hard part. The other two have no element under them at
 * the moment they fire:
 *
 *   - an `after-delay` fires because a SCREEN arrived, not because anyone did
 *     anything;
 *   - a `key` fires wherever focus happens to be, which in a live frame is
 *     usually nothing in particular.
 *
 * So they are screen-scoped, they are mounted once beside the player rather
 * than per node, and they live here together because they are the same
 * question asked twice.
 *
 * WHY THE TIMERS ARE HERE AND THE RULES ARE NOT
 * ─────────────────────────────────────────────
 * `delayTriggersForScreen` (`@core/studio-prototype`) answers WHAT a screen
 * owes; this hook owns the `setTimeout` that pays it. A timer is a side effect
 * and the stack machine is pure — the same split `applyPlayAction` already
 * makes with the store. It also means the "which links does arriving here
 * start?" rule is unit-testable without fake timers.
 *
 * WHY A KEY LISTENER ON THE PARENT DOCUMENT IS NOT ENOUGH
 * ──────────────────────────────────────────────────────
 * A keystroke inside the play iframe never reaches the parent document — that
 * is the whole reason `useIframeEventForwarding` exists — and clicking into the
 * running prototype focuses the iframe on the first press. So the live-frame
 * half of this is bridged there, by calling `followPrototypeKeyFromFrame`
 * directly rather than by cloning a `KeyboardEvent` onto the parent document
 * the way the design canvas does: a clone would hand every editor shortcut
 * (undo, save, spotlight, the panel rail) a keystroke the user typed into a
 * running prototype's form field. The listener below covers the other half —
 * focus still in the editor chrome, which is where it is immediately after
 * pressing Play.
 */
import { useEffect } from 'react'
import { delayTriggersForScreen } from '@core/studio-prototype'
import { useEditorStore } from '@site/store/store'
import { resolvedLinkSourceIds } from '@site/store/slices/prototypeSelectors'
import { followPrototypeKey } from '@site/studio/playNavigation'
import { isTextInputTarget } from './editorKeyGuards'

/**
 * A keystroke the player must not read as a prototype trigger.
 *
 * A modifier held means the user is reaching for an editor shortcut (or their
 * own OS), and a single printable key is exactly what a `key` trigger is — so
 * the two are told apart by the modifiers rather than by a list of keys the
 * editor happens to use today.
 */
function isPlainKeystroke(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey
}

/**
 * Whether `event` should follow a `key`-triggered link. Exported because the
 * live-frame bridge in `useIframeEventForwarding` asks the same question about
 * an event the parent document will never see.
 */
export function shouldFollowPrototypeKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false
  if (!isPlainKeystroke(event)) return false
  // Typing into the running prototype's own form field is typing, not a
  // trigger. Same stand-down every canvas key layer makes for an inline edit.
  if (isTextInputTarget(event.target)) return false
  return true
}

/**
 * Which pages the player is showing, published for the live-frame bridge.
 *
 * Module-scoped rather than read back out of the store because the START screen
 * is not in `playState` at all — an untouched player has two empty stacks and
 * shows whatever page the editor had open, a fact only `usePrototypePlayback`
 * assembles. Re-deriving it in the bridge would be a second, driftable copy of
 * that derivation, and it is the case a `key` trigger is most likely to be used
 * in: the first screen.
 */
let playScope: { screenPageId: string | null; overlayPageId: string | null } = {
  screenPageId: null,
  overlayPageId: null,
}

/**
 * Follow the key link for a keystroke raised INSIDE a play frame.
 *
 * Its own entry point, rather than the hook's listener, because the event
 * cannot be re-dispatched into the parent document without handing it to every
 * editor shortcut as well.
 */
export function followPrototypeKeyFromFrame(event: KeyboardEvent): void {
  if (!useEditorStore.getState().playMode) return
  if (!shouldFollowPrototypeKey(event)) return
  if (followPrototypeKey(event.key, [playScope.overlayPageId, playScope.screenPageId])) {
    event.preventDefault()
  }
}

interface PlayTriggerScope {
  /** The player is armed. Everything here stands down when it is not. */
  playMode: boolean
  /** The screen showing, or `null`. */
  screenPageId: string | null
  /** The overlay presented over it, or `null`. */
  overlayPageId: string | null
  /**
   * How deep the screen stack is. In the deps so that navigating BACK to a
   * screen the prototype already visited re-arms its timers — the page id
   * alone is unchanged there, and a splash screen you returned to should
   * splash again.
   */
  stackDepth: number
}

/** Mounts the delay timers and the parent-document key listener. */
export function usePrototypePlayTriggers({
  playMode,
  screenPageId,
  overlayPageId,
  stackDepth,
}: PlayTriggerScope): void {
  useEffect(() => {
    if (!playMode) {
      playScope = { screenPageId: null, overlayPageId: null }
      return
    }
    playScope = { screenPageId, overlayPageId }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldFollowPrototypeKey(event)) return
      if (followPrototypeKey(event.key, [overlayPageId, screenPageId])) event.preventDefault()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [playMode, screenPageId, overlayPageId])

  useEffect(() => {
    if (!playMode) return
    // The TOP surface owns the clock. A sheet presented over a screen whose
    // splash timer is still running would otherwise be replaced out from under
    // the user by a navigation they can no longer see the source of.
    const pageId = overlayPageId ?? screenPageId
    if (!pageId) return

    const state = useEditorStore.getState()
    const pages = state.site?.pages
    if (!pages) return
    const pending = delayTriggersForScreen(
      state.prototype.links,
      resolvedLinkSourceIds(state.prototype.links, pages),
      pageId,
    )
    if (pending.length === 0) return

    const timers = pending.map(({ link, ms }) =>
      // Read the follow action out of the store at FIRE time, not now: the
      // player may have moved on, and `followPrototypeLink` returning false on
      // a stale stack is exactly the no-op we want rather than a toast.
      setTimeout(() => {
        if (!useEditorStore.getState().playMode) return
        useEditorStore.getState().followPrototypeLink(link)
      }, ms),
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
    // `stackDepth` is a dependency on purpose — see `PlayTriggerScope`.
  }, [playMode, screenPageId, overlayPageId, stackDepth])
}
