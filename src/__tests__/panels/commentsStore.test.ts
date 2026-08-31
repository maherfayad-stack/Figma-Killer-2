/**
 * The editor-side comment state: the slice's mode interlocks and the
 * selectors the canvas and panel subscribe to.
 *
 * The interlock assertions are the ones worth having. Each describes a way two
 * competing "this is the comment you are working on" surfaces could end up on
 * screen at once, which is the failure mode a modal placement tool invites.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import {
  matchesCommentFilter,
  matchesCommentSearch,
  selectActiveCommentThread,
  selectOpenCommentCount,
  selectThreadAnchorConfidence,
  visibleThreads,
} from '@site/store/slices/commentSelectors'
import {
  createCommentsFile,
  createThread,
  setThreadResolved,
  type CommentAnchor,
  type CommentAuthor,
  type CommentsFile,
} from '@core/studio-comments'

const maher: CommentAuthor = { userId: 'u1', displayName: 'Maher', kind: 'user' }
const agent: CommentAuthor = { userId: 'u1', displayName: 'Studio agent', kind: 'agent' }

const anchor = (over: Partial<CommentAnchor> = {}): CommentAnchor => ({
  frameId: 'f1',
  pageId: 'home',
  dx: 10,
  dy: 20,
  node: null,
  ...over,
})

function file(
  entries: ReadonlyArray<{ boardId?: string; author?: CommentAuthor; body: string; anchor?: CommentAnchor }>,
): CommentsFile {
  let next = createCommentsFile()
  entries.forEach((entry, i) => {
    next = createThread(next, {
      id: `t${i + 1}`,
      commentId: `c${i + 1}`,
      boardId: entry.boardId ?? 'b1',
      anchor: entry.anchor ?? anchor(),
      author: entry.author ?? maher,
      body: entry.body,
      // Distinct, increasing timestamps so the newest-first ordering is real.
      now: `2026-08-3${i + 1}T09:00:00.000Z`,
    })!
  })
  return next
}

/**
 * `useEditorStore` is a module singleton shared across every test file in a
 * `bun test` process, so a slice left dirty here surfaces as an unrelated
 * failure somewhere else entirely. Reset the comment fields before each test.
 */
beforeEach(() => {
  useEditorStore.setState({
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
  })
})

describe('mode interlocks', () => {
  it('arming the tool closes an open thread and discards a draft', () => {
    // Otherwise the next click places a pin while a popover is still up —
    // two surfaces both claiming to be the comment being worked on.
    useEditorStore.setState({
      activeThreadId: 't1',
      draftPin: { boardId: 'b1', anchor: anchor() },
    })
    useEditorStore.getState().setCommentToolActive(true)

    const s = useEditorStore.getState()
    expect(s.commentToolActive).toBe(true)
    expect(s.activeThreadId).toBeNull()
    expect(s.draftPin).toBeNull()
  })

  it('placing a pin disarms the tool, so one C press places one comment', () => {
    // A tool that stays armed across placements leaves a trail of pins behind
    // a mis-click, each of which is a thread someone has to clean up.
    useEditorStore.getState().setCommentToolActive(true)
    useEditorStore.getState().beginDraftPin({ boardId: 'b1', anchor: anchor() })

    const s = useEditorStore.getState()
    expect(s.commentToolActive).toBe(false)
    expect(s.draftPin).not.toBeNull()
    expect(s.activeThreadId).toBeNull()
  })

  it('opening an existing thread abandons an uncommitted draft', () => {
    useEditorStore.getState().beginDraftPin({ boardId: 'b1', anchor: anchor() })
    useEditorStore.getState().setActiveCommentThread('t1')

    expect(useEditorStore.getState().draftPin).toBeNull()
    expect(useEditorStore.getState().activeThreadId).toBe('t1')
  })

  it('arming the tool opens the comments pane — one gesture, one mode', () => {
    useEditorStore.getState().setCommentToolActive(true)
    expect(useEditorStore.getState().commentsPaneOpen).toBe(true)
  })

  it('opening a thread opens the pane, and closing the pane does not close the thread', () => {
    // The pane is a list; the popover is a conversation. Closing the list must
    // not throw away the conversation the user is mid-reply in.
    useEditorStore.getState().setActiveCommentThread('t1')
    expect(useEditorStore.getState().commentsPaneOpen).toBe(true)

    useEditorStore.getState().setCommentsPaneOpen(false)
    expect(useEditorStore.getState().activeThreadId).toBe('t1')
  })

  it('closing the pane discards the bulk selection', () => {
    // A working set that outlived the surface showing it would let a later
    // "Delete selected" act on threads the user has no memory of choosing.
    useEditorStore.getState().setSelectedThreads(['t1', 't2'])
    useEditorStore.getState().setCommentsPaneOpen(false)
    expect(useEditorStore.getState().selectedThreadIds).toEqual([])
  })

  it('toggles one thread in and out of the working set', () => {
    const { toggleThreadSelected } = useEditorStore.getState()
    toggleThreadSelected('t1')
    toggleThreadSelected('t2')
    expect(useEditorStore.getState().selectedThreadIds).toEqual(['t1', 't2'])
    toggleThreadSelected('t1')
    expect(useEditorStore.getState().selectedThreadIds).toEqual(['t2'])
  })

  it('keeps a load failure distinct from "loaded, and empty"', () => {
    useEditorStore.getState().markCommentsLoadFailed()
    expect(useEditorStore.getState().commentsLoadFailed).toBe(true)
    expect(useEditorStore.getState().commentsLoaded).toBe(false)

    useEditorStore.getState().loadComments(createCommentsFile())
    expect(useEditorStore.getState().commentsLoadFailed).toBe(false)
    expect(useEditorStore.getState().commentsLoaded).toBe(true)
  })
})

describe('selectors', () => {
  it('counts only open threads', () => {
    const two = file([{ body: 'a' }, { body: 'b' }])
    useEditorStore.getState().loadComments(setThreadResolved(two, 't1', true)!)
    expect(selectOpenCommentCount(useEditorStore.getState())).toBe(1)
  })

  it('resolves the active thread, or null when it is gone', () => {
    useEditorStore.getState().loadComments(file([{ body: 'a' }]))
    useEditorStore.getState().setActiveCommentThread('t1')
    expect(selectActiveCommentThread(useEditorStore.getState())?.seq).toBe(1)

    useEditorStore.getState().setActiveCommentThread('deleted')
    expect(selectActiveCommentThread(useEditorStore.getState())).toBeNull()
  })

  it('orders the panel newest-first — it is a work queue, not a numbered list', () => {
    const threads = file([{ body: 'older' }, { body: 'newer' }]).threads
    expect(visibleThreads(threads, 'all', '').map((t) => t.seq)).toEqual([2, 1])
  })

  it('never sorts the stored array in place — the pins keep their own order', () => {
    // `.sort()` mutates. Sorting the store's array would silently reorder the
    // canvas layer, which reads the same reference and expects insertion order.
    const stored = file([{ body: 'older' }, { body: 'newer' }]).threads
    visibleThreads(stored, 'all', '')
    expect(stored.map((t) => t.seq)).toEqual([1, 2])
  })

  it('reports `unanchored`, never `detached`, for a pin that never named an element', () => {
    // The distinction the agent gate depends on — see anchorResolve.ts.
    useEditorStore.getState().loadComments(file([{ body: 'floating', anchor: anchor({ node: null }) }]))
    const s = useEditorStore.getState()
    expect(selectThreadAnchorConfidence(s, s.comments.threads[0]!)).toBe('unanchored')
  })
})

describe('filter and search', () => {
  const open = file([{ body: 'a' }]).threads[0]!
  const done = setThreadResolved(file([{ body: 'a' }]), 't1', true)!.threads[0]!

  it('filters by resolution', () => {
    expect(matchesCommentFilter(open, 'open')).toBe(true)
    expect(matchesCommentFilter(open, 'resolved')).toBe(false)
    expect(matchesCommentFilter(done, 'resolved')).toBe(true)
    expect(matchesCommentFilter(open, 'all')).toBe(true)
    expect(matchesCommentFilter(done, 'all')).toBe(true)
  })

  it('searches bodies AND author names, so "everything Sam said" is one query', () => {
    const thread = file([{ body: 'Use the display face', author: agent }]).threads[0]!
    expect(matchesCommentSearch(thread, 'display')).toBe(true)
    expect(matchesCommentSearch(thread, 'STUDIO AGENT')).toBe(true)
    expect(matchesCommentSearch(thread, 'nothing here')).toBe(false)
    expect(matchesCommentSearch(thread, '   ')).toBe(true)
  })

  it('matches the pin number, bare and prefixed — how people refer to a thread', () => {
    const thread = file([{ body: 'a' }]).threads[0]!
    expect(matchesCommentSearch(thread, '1')).toBe(true)
    expect(matchesCommentSearch(thread, '#1')).toBe(true)
    expect(matchesCommentSearch(thread, '2')).toBe(false)
  })
})
