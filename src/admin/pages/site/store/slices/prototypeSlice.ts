/**
 * prototypeSlice — the editor's view of a project's flows, the transient state
 * of a connector being drawn, and the player's screen stacks.
 *
 * ONE SLICE FOR ONE FEATURE. Authoring a link, drawing it, inspecting it and
 * following it are the same feature seen from four places, and every reader of
 * one of these fields is already reading another — a component that draws
 * connectors needs the mode, the links and the draft; the player needs the
 * links and the stacks. Splitting them would only mean subscribing to two
 * slices to answer one question.
 *
 * Two collections, and the difference between them is the whole feature:
 *
 *   - `prototype` — the links the USER drew, read from and written back to
 *     `<workspace>/.studio/prototype.json`. A design layer.
 *   - `codeFlow` — the navigation Studio DERIVED from the project's own source
 *     (`prototypeCodeFlow.ts` on the server). Read-only, never persisted,
 *     recomputed on every load. It is the part of the board that is true before
 *     anybody has drawn anything.
 *
 * NO HTTP HAPPENS HERE. The slice is a pure state container; the round trips
 * live in `@site/studio/prototypeActions.ts`, exactly the split `commentsSlice`
 * documents for itself and `boardSlice` prescribes generally.
 *
 * WHY `boardMode` LIVES HERE AND NOT IN `uiSlice`
 * ───────────────────────────────────────────────
 * `STUDIO-PROTOTYPE-PLAN.md` §6 put it in `uiSlice` alongside `canvasView`. It
 * is one flag either way, but it belongs with the state it gates: every reader
 * of `boardMode` is already reading `codeFlow` or `prototype`, and a component
 * that shows connectors would otherwise subscribe to two slices to answer one
 * question. `canvasView` (design/live) stays in `uiSlice` because it is about
 * the canvas SURFACE and means something on every CMS route too; `boardMode` is
 * meaningless without a Studio board.
 *
 * WHY THE MODE IS NOT PERSISTED
 * ─────────────────────────────
 * Prototype mode suppresses design chrome. Restoring it on load would open the
 * editor in a state where the user's first click does not select anything, with
 * no memory of having asked for that. Figma reopens on the Design tab too.
 */
import type { EditorStoreSliceCreator } from '@site/store/types'
import {
  INITIAL_PLAY_STATE,
  applyPlayAction,
  createCodeFlow,
  createPrototypeFile,
  type CodeFlow,
  type PlayState,
  type PrototypeFile,
  type PrototypeLink,
  type PrototypeTransition,
} from '@core/studio-prototype'

/**
 * A connector being dragged, in BOARD coordinates.
 *
 * Deliberately NOT a `PrototypeLink` with a null target: a half-drawn gesture
 * the user abandons must leave nothing behind, and giving it the real shape is
 * how it ends up accidentally persisted. It becomes a link only at the drop,
 * in `prototypeActions`.
 */
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
  /**
   * How the gesture ends. `drag` commits on pointer-up, because the user is
   * holding the button down. `pick` was started from the selection toolbar
   * with a click, so the button is already up: it commits on the NEXT click,
   * and Escape cancels.
   */
  mode: 'drag' | 'pick'
}

/**
 * Which layer of the board is being worked on.
 *
 *   - `design`    — the normal editing board. No connectors are drawn.
 *   - `prototype` — flows are drawn over the frames.
 *
 * This is NOT `canvasView`'s design/live axis. A board is in one of these two
 * modes while `canvasView` is `design`; `live` is the player, and has no
 * connectors of its own to show.
 */
export type BoardMode = 'design' | 'prototype'

export interface PrototypeSlice {
  /** Authored links (`.studio/prototype.json`). */
  prototype: PrototypeFile
  /** Navigation derived from the project's own source. Read-only. */
  codeFlow: CodeFlow
  prototypeLoaded: boolean
  /** The fetch failed — draw no connectors rather than claiming the project has no flows. */
  prototypeLoadFailed: boolean
  boardMode: BoardMode
  /** Link whose properties the inspector is showing, or `null`. */
  selectedLinkId: string | null
  linkDraft: LinkDraft | null
  /**
   * A link the selection toolbar asked for, waiting on board geometry.
   *
   * The toolbar knows WHICH node but nothing about where it is on the board,
   * and a draft needs a real anchor to draw from. `BoardPrototypeLayer` is the
   * only thing that can measure that, so it converts this into a `pick` draft
   * on its next render and clears it. Two steps because the alternative —
   * teaching the toolbar board geometry — would be a second implementation of
   * the layer's measurement.
   */
  pendingLinkSource: { pageId: string; nodeId: string } | null
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
  /**
   * The presentation the thing that just LEFT was wearing, so it can be played
   * in reverse on the way out. Only a `back` or a `close` sets it.
   */
  playLeaveTransition: PrototypeTransition | null

  /** Adopt a freshly-read authored link file (from a load or an op's merged response). */
  adoptPrototype: (file: PrototypeFile) => void
  /** Adopt a freshly-derived code flow map. */
  adoptCodeFlow: (flow: CodeFlow) => void
  setPrototypeLoadFailed: (failed: boolean) => void
  setBoardMode: (mode: BoardMode) => void
  setSelectedLink: (linkId: string | null) => void
  setPlayMode: (active: boolean) => void
  /**
   * Follow a link. Returns false when the action changed nothing — a `back` on
   * the entry screen, a `close` with nothing presented — so the caller can say
   * so instead of silently doing nothing.
   */
  followPrototypeLink: (link: PrototypeLink) => boolean
  beginLinkDraft: (draft: LinkDraft) => void
  /** Selection toolbar entry point — see `pendingLinkSource`. */
  requestLinkFromNode: (source: { pageId: string; nodeId: string }) => void
  clearPendingLinkSource: () => void
  /** Move the loose end. A no-op when no drag is in flight. */
  updateLinkDraft: (position: { toX: number; toY: number; hoverPageId: string | null }) => void
  cancelLinkDraft: () => void
}

export const createPrototypeSlice: EditorStoreSliceCreator<PrototypeSlice> = (set, get) => ({
  prototype: createPrototypeFile(),
  codeFlow: createCodeFlow(),
  prototypeLoaded: false,
  prototypeLoadFailed: false,
  boardMode: 'design',
  selectedLinkId: null,
  pendingLinkSource: null,
  linkDraft: null,
  playMode: false,
  playState: INITIAL_PLAY_STATE,
  playTransition: null,
  playLeaveTransition: null,

  adoptPrototype: (file) =>
    set((s) => {
      s.prototype = file
      s.prototypeLoaded = true
      s.prototypeLoadFailed = false
      // A link the server no longer has cannot stay selected — the inspector
      // would be editing something that does not exist.
      if (s.selectedLinkId && !file.links.some((link) => link.id === s.selectedLinkId)) {
        s.selectedLinkId = null
      }
    }),

  adoptCodeFlow: (flow) =>
    set((s) => {
      s.codeFlow = flow
    }),

  setPrototypeLoadFailed: (failed) =>
    set((s) => {
      s.prototypeLoadFailed = failed
    }),

  setBoardMode: (mode) => {
    if (Object.is(get().boardMode, mode)) return
    set((s) => {
      s.boardMode = mode
      // The inspector body is per-mode, so arriving in prototype mode should
      // put the user on the panel they came for rather than leaving them on
      // Comments with nothing about flows on screen.
      if (mode === 'prototype') s.rightSidebarTab = 'properties'
      // Leaving takes any half-drawn gesture with it: a rubber band that
      // survives the mode it belongs to has nothing left to commit into.
      else {
        s.linkDraft = null
        s.pendingLinkSource = null
        s.selectedLinkId = null
      }
    })
  },

  setSelectedLink: (linkId) =>
    set((s) => {
      s.selectedLinkId = linkId
    }),

  setPlayMode: (active) =>
    set((s) => {
      s.playMode = active
      // The hover ring is editing chrome and the player is not an editing
      // surface — `useCanvasNodeInteraction` stops WRITING it while armed, so
      // whatever was lit when Play was pressed has to be cleared here or it
      // stays lit for the whole session.
      if (active) {
        s.hoveredNodeId = null
        s.hoveredBreakpointId = null
        s.hoveredFrameId = null
      }
      // Disarming returns the player to its starting screen. Leaving it three
      // screens deep with the arrow cursor back would make the live frame show
      // a page the editor does not think is open.
      if (!active) {
        s.playState = INITIAL_PLAY_STATE
        s.playTransition = null
        s.playLeaveTransition = null
      }
    }),

  followPrototypeLink: (link) => {
    let moved = false
    set((s) => {
      const outcome = applyPlayAction(s.playState, link)
      if (outcome.state === s.playState) return
      s.playState = outcome.state
      s.playTransition = outcome.entering
      s.playLeaveTransition = outcome.leaving
      moved = true
    })
    return moved
  },

  beginLinkDraft: (draft) =>
    set((s) => {
      s.linkDraft = draft
      // Starting a new connector puts the inspector on the gesture in progress,
      // not on whichever link happened to be selected before it.
      s.selectedLinkId = null
    }),

  updateLinkDraft: (position) =>
    set((s) => {
      if (!s.linkDraft) return
      s.linkDraft.toX = position.toX
      s.linkDraft.toY = position.toY
      s.linkDraft.hoverPageId = position.hoverPageId
    }),

  cancelLinkDraft: () =>
    set((s) => {
      s.linkDraft = null
      s.pendingLinkSource = null
    }),

  requestLinkFromNode: (source) =>
    set((s) => {
      s.pendingLinkSource = source
      s.linkDraft = null
      s.selectedLinkId = null
    }),

  clearPendingLinkSource: () =>
    set((s) => {
      s.pendingLinkSource = null
    }),
})

declare module '@site/store/types' {
  interface EditorStore extends PrototypeSlice {}
}
