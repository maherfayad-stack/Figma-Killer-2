/**
 * usePrototypePlayback — which page the LIVE frame shows while the player is
 * armed, and how it should animate in.
 *
 * Extracted from `CanvasRoot` rather than inlined there: the derivation is four
 * related decisions with one reason between them, and `CanvasRoot` is already
 * at the 700-line god-file ceiling that `module-size-budgets` enforces.
 *
 * The rule the whole hook exists to state: arming the player changes what is
 * BEING LOOKED AT, never what is being edited. Selection overlays, the
 * properties panel and the page tree all keep pointing at the editing page, so
 * disarming the player puts the editor back exactly where it was.
 */
import type { Page } from '@core/page-tree'
import { currentOverlay, currentScreen, type PrototypeTransition } from '@core/studio-prototype'
import { useEditorStore } from '@site/store/store'

export interface PrototypePlayback {
  /** The page the canvas should render — the play screen when armed. */
  canvasPage: Page | null
  /** The overlay presented on top of it, or null. */
  overlayPage: Page | null
  /** Entrance animation for a screen that just replaced another. */
  screenTransition: PrototypeTransition | null
  /** Entrance animation for an overlay that was just presented. */
  overlayTransition: PrototypeTransition | null
  /**
   * The presentation the overlay that just LEFT was wearing, so it can be
   * played in reverse on the way out. Set by a `back`, a `close`, or a tap on
   * the scrim.
   */
  overlayLeaveTransition: PrototypeTransition | null
  /** Whether clicks in the live frame belong to the player. */
  playMode: boolean
}

export function usePrototypePlayback(editingPage: Page | null): PrototypePlayback {
  const playMode = useEditorStore((s) => s.playMode)
  const playState = useEditorStore((s) => s.playState)
  const playTransition = useEditorStore((s) => s.playTransition)
  const playLeaveTransition = useEditorStore((s) => s.playLeaveTransition)
  const pages = useEditorStore((s) => s.site?.pages)

  if (!playMode) {
    return {
      canvasPage: editingPage,
      overlayPage: null,
      screenTransition: null,
      overlayTransition: null,
      overlayLeaveTransition: null,
      playMode: false,
    }
  }

  const screenId = currentScreen(playState, editingPage?.id ?? null)
  const overlayId = currentOverlay(playState)

  // A screen the prototype points at but the project no longer has falls back
  // to the editing page rather than blanking the canvas — a deleted target is
  // a prototype bug to see, not a reason to show nothing.
  const canvasPage =
    screenId && screenId !== editingPage?.id
      ? pages?.find((candidate) => candidate.id === screenId) ?? editingPage
      : editingPage
  const overlayPage = overlayId ? pages?.find((candidate) => candidate.id === overlayId) ?? null : null

  // One transition, applied to whichever surface just arrived. An overlay
  // animates itself in; without one, the screen underneath is what changed.
  return {
    canvasPage,
    overlayPage,
    screenTransition: overlayPage ? null : playTransition,
    overlayTransition: overlayPage ? playTransition : null,
    overlayLeaveTransition: playLeaveTransition,
    playMode: true,
  }
}
