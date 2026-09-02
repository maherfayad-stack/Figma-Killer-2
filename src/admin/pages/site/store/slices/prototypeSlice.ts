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
import {
  INITIAL_PLAY_STATE,
  applyPlayAction,
  createPrototypeFile,
  type PlayState,
  type PrototypeFile,
  type PrototypeLink,
  type PrototypeTransition,
} from '@core/studio-prototype'

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
   * Without this a click in live mode would mean both things at once, which is
   * not resolvable. It is separate from `boardMode` on purpose: arming the
   * player is about the live frame, authoring links is about the board.
   */
  playMode: boolean
  /**
   * The two screen stacks. The MACHINE lives in `@core/studio-prototype`'s
   * `playback.ts` — this slice only holds its state and hands it back, so the
   * rules about what `back` pops are stated once and are unit-testable without
   * a store.
   */
  playState: PlayState
  /**
   * The transition of the LAST followed link — the animation the incoming
   * screen or overlay should play, and nothing more.
   *
   * Stored rather than derived because `PlayState` is a stack of page ids: once
   * an action has been applied there is no longer anything in it that says HOW
   * you arrived. `back` and `close` carry no transition of their own (they
   * reverse whatever brought you here), so they leave this null and the
   * component reverses the presentation itself.
   */
  playTransition: PrototypeTransition | null

  loadPrototype: (file: PrototypeFile) => void
  markPrototypeLoadFailed: () => void
  /** Adopt the server's merged file after an op. */
  adoptPrototype: (file: PrototypeFile) => void
  setSelectedLink: (linkId: string | null) => void
  setPlayMode: (active: boolean) => void
  /**
   * Follow a link. Returns false when the action changed nothing — a `back` on
   * the entry screen, a `close` with nothing presented — so the caller can say
   * so instead of silently doing nothing.
   */
  followPrototypeLink: (link: PrototypeLink) => boolean
  /** Return the player to where it started. */
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
  playState: INITIAL_PLAY_STATE,
  playTransition: null,

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
      // a page the editor does not think is open.
      if (!active) {
        s.playState = INITIAL_PLAY_STATE
        s.playTransition = null
      }
    })
  },

  followPrototypeLink: (link) => {
    let moved = false
    set((s) => {
      const next = applyPlayAction(s.playState, link)
      if (next === s.playState) return
      s.playState = next
      s.playTransition = link.transition ?? null
      moved = true
    })
    return moved
  },

  resetPlay: () => {
    set((s) => {
      s.playState = INITIAL_PLAY_STATE
      s.playTransition = null
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
