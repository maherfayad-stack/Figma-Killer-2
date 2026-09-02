/**
 * commentsSlice — the editor's view of `<workspace>/.studio/comments.json`,
 * plus the transient UI state around it (which tool is armed, which thread is
 * open, where an uncommitted pin is sitting).
 *
 * NO HTTP HAPPENS HERE. The slice is a pure state container; the round trip
 * lives in `@site/studio/commentActions.ts`, which posts one op and then hands
 * the server's merged file back through `adoptComments`. That is the same
 * split `boardSlice`'s own doc prescribes for `frameDefaults` ("persisting the
 * default is the UI action's job … the store stays a pure state container with
 * no direct HTTP calls").
 *
 * WHY THERE IS NO `commentsDirty` FLAG
 * ────────────────────────────────────
 * `boardSlice` accumulates local edits and flushes them 800 ms later, because
 * dragging a frame produces a burst of writes that would otherwise be a burst
 * of requests. Comments are the opposite shape: a write is one deliberate
 * submit, seconds apart, and it must be durable the instant it is
 * acknowledged — a debounce here would mean a reply that the author saw on
 * screen and that a browser close silently discarded. So each op is sent
 * immediately and the server's response REPLACES local state wholesale. That
 * replacement is not a formality: the returned file may carry a comment this
 * client had never seen, from a reviewer in another session.
 *
 * READING ONE COMMENT vs. ENTERING COMMENT MODE
 * ──────────────────────────────────────────────
 * `commentsPaneOpen` says the Comments pane is available in the right sidebar;
 * `rightSidebarTab` (in `uiSlice`) says which of Comments and Properties is
 * showing when both are. The line runs
 * between those two intentions:
 *
 *   - Arming the `C` tool (the key or the Comment button) OPENS the pane, and
 *     DISARMING it closes the pane again. That gesture means "I am doing a
 *     review pass now" / "I am done", and the queue belongs to that mode. It
 *     is also what makes the pane discoverable from the canvas.
 *   - Clicking a pin does NOT. It means "what does this one say".
 *
 * The distinction is not cosmetic. Opening the right sidebar SHRINKS the canvas
 * viewport, so when a pin click opened the pane it reflowed the whole board and
 * shoved the very pin you had just clicked out from under the cursor, while the
 * popover flipped sides to dodge the pane that had appeared. Reading one comment
 * must not re-lay-out the editor. Entering a review pass may.
 *
 * Closing the pane still clears the bulk working set, so a stale selection can
 * never act on threads the user can no longer see.
 */
import type { EditorStoreSliceCreator } from '@site/store/types'
import { createCommentsFile, type CommentAnchor, type CommentsFile } from '@core/studio-comments'

/** Which threads the panel and the canvas show. Mirrors Figma's own filter. */
export type CommentFilter = 'open' | 'resolved' | 'all'

/**
 * A pin that has been PLACED but not yet committed — the popover is open and
 * waiting for its first comment. It lives in the store rather than in the
 * popover's local state so that clicking elsewhere on the canvas can discard
 * it, which is the behaviour Figma has and the reason an abandoned draft never
 * becomes a permanent, empty, unopenable marker.
 */
export interface DraftPin {
  boardId: string
  anchor: CommentAnchor
}

export interface CommentsSlice {
  comments: CommentsFile
  commentsLoaded: boolean
  /** The fetch failed — render the layer empty rather than pretending there are no comments. */
  commentsLoadFailed: boolean
  /** Comment-placement mode (the `C` tool). The canvas swallows clicks while this is on. */
  commentToolActive: boolean
  /** Thread whose popover is open, or `null`. */
  activeThreadId: string | null
  draftPin: DraftPin | null
  commentFilter: CommentFilter
  commentSearch: string
  /** The right sidebar's comments mode. */
  commentsPaneOpen: boolean
  /**
   * The bulk-action working set, as thread ids. Ids rather than indices
   * because the list re-sorts under the user (newest-first) and the file is
   * replaced wholesale on every write, including writes from other people.
   */
  selectedThreadIds: readonly string[]

  /** Hydrate from a successful fetch. */
  loadComments: (file: CommentsFile) => void
  /** The fetch failed. Distinct from "loaded, and empty". */
  markCommentsLoadFailed: () => void
  /** Adopt the server's merged file after an op (or a live push from the agent). */
  adoptComments: (file: CommentsFile) => void
  setCommentToolActive: (active: boolean) => void
  setActiveCommentThread: (threadId: string | null) => void
  beginDraftPin: (draft: DraftPin) => void
  cancelDraftPin: () => void
  setCommentFilter: (filter: CommentFilter) => void
  setCommentSearch: (search: string) => void
  setCommentsPaneOpen: (open: boolean) => void
  toggleThreadSelected: (threadId: string) => void
  /** Replace the working set outright — the header's select-all checkbox. */
  setSelectedThreads: (threadIds: readonly string[]) => void
  clearSelectedThreads: () => void
}

declare module '@site/store/types' {
  interface EditorStore extends CommentsSlice {}
}

export const createCommentsSlice: EditorStoreSliceCreator<CommentsSlice> = (set, get) => ({
  comments: createCommentsFile(),
  commentsLoaded: false,
  commentsLoadFailed: false,
  commentToolActive: false,
  activeThreadId: null,
  draftPin: null,
  commentFilter: 'open',
  commentSearch: '',
  commentsPaneOpen: false,
  selectedThreadIds: [],

  loadComments: (file) => {
    set((s) => {
      s.comments = file
      s.commentsLoaded = true
      s.commentsLoadFailed = false
    })
  },

  markCommentsLoadFailed: () => {
    set((s) => {
      s.commentsLoadFailed = true
      s.commentsLoaded = false
    })
  },

  adoptComments: (file) => {
    set((s) => {
      s.comments = file
      s.commentsLoaded = true
      s.commentsLoadFailed = false
    })
  },

  setCommentToolActive: (active) => {
    set((s) => {
      s.commentToolActive = active
      // Arming the tool closes whatever thread was open: the next click is
      // going to place a pin, so leaving a popover up would put two
      // competing "this is the comment you are working on" surfaces on
      // screen at once.
      if (active) {
        s.activeThreadId = null
        s.draftPin = null
        // Arming the tool IS "I am reviewing now" — bring the queue with it,
        // and put the sidebar on it. Clicking a single pin deliberately does
        // not open the pane; see the module doc.
        s.commentsPaneOpen = true
        s.rightSidebarTab = 'comments'
      }
    })

    // Leaving comment mode takes the queue with it — the exact inverse of
    // arming, so `C` `C` returns the editor to where it started instead of
    // leaving a pane behind that the user now has to close by hand.
    //
    // Routed through `setCommentsPaneOpen` rather than written inline so the
    // bulk working set is dropped by the one implementation that owns that
    // rule. And it is safe to hang off THIS action: the automatic disarm when
    // a pin is placed writes `commentToolActive` directly in `beginDraftPin`,
    // so committing a comment does not yank the queue out from under the
    // composer that is still open.
    if (!active) get().setCommentsPaneOpen(false)
  },

  setActiveCommentThread: (threadId) => {
    set((s) => {
      s.activeThreadId = threadId
      // Opening an existing thread abandons an uncommitted draft — the same
      // discard rule as clicking the canvas.
      if (threadId !== null) {
        s.draftPin = null
        // Does NOT open the pane (that would reflow the board and move the pin
        // out from under the cursor). It only decides which tab the sidebar
        // shows if it is ALREADY open — reading a thread while the sidebar sits
        // on Properties should bring the queue forward, not leave the two
        // disagreeing about what is being looked at.
        s.rightSidebarTab = 'comments'
      }
    })
  },

  beginDraftPin: (draft) => {
    set((s) => {
      s.draftPin = draft
      s.activeThreadId = null
      // Placing a pin disarms the tool, so a single `C` press places exactly
      // one comment. Holding the tool armed across placements would make it
      // very easy to leave a trail of pins behind a mis-click.
      s.commentToolActive = false
    })
  },

  cancelDraftPin: () => {
    set((s) => {
      s.draftPin = null
    })
  },

  setCommentFilter: (filter) => {
    set((s) => {
      s.commentFilter = filter
    })
  },

  setCommentSearch: (search) => {
    set((s) => {
      s.commentSearch = search
    })
  },

  setCommentsPaneOpen: (open) => {
    set((s) => {
      s.commentsPaneOpen = open
      if (open) s.rightSidebarTab = 'comments'
      // Closing the pane ends the bulk session. A working set that outlived
      // the surface showing it would let a later "Delete selected" act on
      // threads the user has no memory of choosing.
      if (!open) s.selectedThreadIds = []
    })
  },

  toggleThreadSelected: (threadId) => {
    set((s) => {
      s.selectedThreadIds = s.selectedThreadIds.includes(threadId)
        ? s.selectedThreadIds.filter((id) => id !== threadId)
        : [...s.selectedThreadIds, threadId]
    })
  },

  setSelectedThreads: (threadIds) => {
    set((s) => {
      s.selectedThreadIds = [...threadIds]
    })
  },

  clearSelectedThreads: () => {
    set((s) => {
      s.selectedThreadIds = []
    })
  },
})
