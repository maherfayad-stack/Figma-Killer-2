/**
 * prototypeSlice — the editor's view of `<workspace>/.studio/prototype.json`,
 * plus the transient state of a connector being dragged.
 *
 * NO HTTP HAPPENS HERE. The round trip lives in
 * `@site/studio/prototypeActions.ts`, which posts one op and hands the server's
 * merged file back through `adoptPrototype` — the same split `commentsSlice`
 * and `boardSlice` both use.
 *
 * WHY THERE IS NO `prototypeDirty` DEBOUNCE
 * ─────────────────────────────────────────
 * `boardSlice` batches frame drags on an 800 ms flush because dragging emits a
 * burst of writes. Authoring a link is the opposite shape: one deliberate drop,
 * seconds apart from the next. Each op is written through immediately, exactly
 * as comments are.
 *
 * THE DRAFT IS NOT A LINK
 * ───────────────────────
 * `linkDraft` is the rubber band between the `+` handle and the cursor. It is
 * deliberately NOT a `PrototypeLink` with a null target: a half-drawn gesture
 * that the user abandons must leave nothing behind, and giving it the real
 * shape is how it ends up accidentally persisted. It becomes a link only at
 * the drop, in `prototypeActions`.
 */
import type { EditorStoreSliceCreator } from '@site/store/types'
import { createPrototypeFile, type PrototypeFile } from '@core/studio-prototype'

/** A connector being dragged, in BOARD coordinates. */
export interface LinkDraft {
  /** Page the `+` handle belongs to. */
  sourcePageId: string
  /** Element the `+` handle belongs to, as its id resolves RIGHT NOW. */
  sourceNodeId: string
  /** Where the rubber band starts — the handle, in board space. */
  fromX: number
  fromY: number
  /** Where the cursor is, in board space. */
  toX: number
  toY: number
  /** Page currently under the cursor, or `null` over empty board. */
  hoverPageId: string | null
}

export interface PrototypeSlice {
  prototype: PrototypeFile
  prototypeLoaded: boolean
  /** The fetch failed — draw no connectors rather than implying there are none. */
  prototypeLoadFailed: boolean
  /** Link whose properties the inspector is showing, or `null`. */
  selectedLinkId: string | null
  linkDraft: LinkDraft | null
  /**
   * The player is ARMED: a click in live mode follows a prototype link instead
   * of selecting a node.
   *
   * This exists because without it a click in live mode would mean both things
   * at once, which is not resolvable — see `STUDIO-PROTOTYPE-PLAN.md` §5. It is
   * separate from `boardMode` on purpose: arming the player is about the live
   * frame, authoring links is about the board.
   */
  playMode: boolean
  /**
   * The screens the player has navigated through, oldest first, as page ids.
   * `back` pops it. Empty means "wherever the player started".
   */
  playHistory: readonly string[]
  /** Overlays currently presented on top, innermost last. `close` pops it. */
  playOverlays: readonly string[]

  loadPrototype: (file: PrototypeFile) => void
  markPrototypeLoadFailed: () => void
  /** Adopt the server's merged file after an op. */
  adoptPrototype: (file: PrototypeFile) => void
  setSelectedLink: (linkId: string | null) => void
  setPlayMode: (active: boolean) => void
  /** Push a screen the player navigated to. */
  pushPlayScreen: (pageId: string) => void
  /** Present an overlay on top of whatever is showing. */
  pushPlayOverlay: (pageId: string) => void
  /** `back` — pop the screen stack. Returns false when there is nowhere to go. */
  popPlayScreen: () => boolean
  /** `close` — dismiss the top overlay. Returns false when none is showing. */
  popPlayOverlay: () => boolean
  /** Return the player to where it started, dropping every stack. */
  resetPlay: () => void
  beginLinkDraft: (draft: LinkDraft) => void
  /** Move the loose end. A no-op when no drag is in flight. */
  updateLinkDraft: (position: { toX: number; toY: number; hoverPageId: string | null }) => void
  cancelLinkDraft: () => void
}

declare module '@site/store/types' {
  interface EditorStore extends PrototypeSlice {}
}

export const createPrototypeSlice: EditorStoreSliceCreator<PrototypeSlice> = (set) => ({
  prototype: createPrototypeFile(),
  prototypeLoaded: false,
  prototypeLoadFailed: false,
  selectedLinkId: null,
  linkDraft: null,
  playMode: false,
  playHistory: [],
  playOverlays: [],

  loadPrototype: (file) => {
    set((s) => {
      s.prototype = file
      s.prototypeLoaded = true
      s.prototypeLoadFailed = false
    })
  },

  markPrototypeLoadFailed: () => {
    set((s) => {
      s.prototypeLoadFailed = true
      s.prototypeLoaded = false
    })
  },

  adoptPrototype: (file) => {
    set((s) => {
      s.prototype = file
      s.prototypeLoaded = true
      s.prototypeLoadFailed = false
      // A link the server no longer has cannot stay selected — the inspector
      // would be editing something that does not exist.
      if (s.selectedLinkId && !file.links.some((l) => l.id === s.selectedLinkId)) {
        s.selectedLinkId = null
      }
    })
  },

  setSelectedLink: (linkId) => {
    set((s) => {
      s.selectedLinkId = linkId
    })
  },

  setPlayMode: (active) => {
    set((s) => {
      s.playMode = active
      // Disarming returns the player to its starting screen. Leaving it three
      // screens deep with the arrow cursor back would make the live frame show
      // a page the page tree does not think is open.
      if (!active) {
        s.playHistory = []
        s.playOverlays = []
      }
    })
  },

  pushPlayScreen: (pageId) => {
    set((s) => {
      // Navigating out from under an overlay dismisses it: the overlay belonged
      // to the screen being left.
      s.playOverlays = []
      s.playHistory = [...s.playHistory, pageId]
    })
  },

  pushPlayOverlay: (pageId) => {
    set((s) => {
      s.playOverlays = [...s.playOverlays, pageId]
    })
  },

  popPlayScreen: () => {
    let popped = false
    set((s) => {
      // `back` closes an overlay first if one is up — that is what the gesture
      // means to someone looking at a sheet over a screen.
      if (s.playOverlays.length > 0) {
        s.playOverlays = s.playOverlays.slice(0, -1)
        popped = true
        return
      }
      if (s.playHistory.length === 0) return
      s.playHistory = s.playHistory.slice(0, -1)
      popped = true
    })
    return popped
  },

  popPlayOverlay: () => {
    let popped = false
    set((s) => {
      if (s.playOverlays.length === 0) return
      s.playOverlays = s.playOverlays.slice(0, -1)
      popped = true
    })
    return popped
  },

  resetPlay: () => {
    set((s) => {
      s.playHistory = []
      s.playOverlays = []
    })
  },

  beginLinkDraft: (draft) => {
    set((s) => {
      s.linkDraft = draft
      // Starting a new connector puts the inspector on the gesture in progress,
      // not on whichever link happened to be selected before it.
      s.selectedLinkId = null
    })
  },

  updateLinkDraft: (position) => {
    set((s) => {
      if (!s.linkDraft) return
      s.linkDraft.toX = position.toX
      s.linkDraft.toY = position.toY
      s.linkDraft.hoverPageId = position.hoverPageId
    })
  },

  cancelLinkDraft: () => {
    set((s) => {
      s.linkDraft = null
    })
  },
})
