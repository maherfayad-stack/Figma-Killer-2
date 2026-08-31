/**
 * CommentsPanel — every review thread in the project, as a work queue.
 *
 * Lives in the RIGHT sidebar (`RightSidebar`, mode `comments`), opening
 * whenever the user starts working on comments: clicking a pin, or pressing
 * `C`. That is the same place the Properties panel appears, and for the same
 * reason — the right sidebar is where you inspect the thing you just clicked.
 * `commentsSlice` owns the open/close interlocks so no call site can forget.
 *
 * The canvas answers "what is being said about THIS"; the panel answers "what
 * is outstanding". So the two views deliberately order differently: pins carry
 * their `seq`, the list is newest-first, because the thing someone just said
 * is the thing to deal with. They never disagree about a thread's NAME, only
 * about its position — which is why `seq` is shown on every row here too.
 *
 * BULK ACTIONS
 * ────────────
 * A checkbox per row plus a select-all in the header. The two bulk actions are
 * Delete and Send to the AI assistant, and they are gated behind an explicit
 * selection rather than acting on "everything currently filtered": a filter is
 * a view, and a destructive action that silently follows the view deletes
 * things the user was only looking at. Select-all fills the working set from
 * the CURRENTLY VISIBLE rows, so filter + search + select-all is still the
 * fast path — it just goes through a state the user can see and undo.
 */
import { useEditorStore } from '@site/store/store'
import {
  selectThreadAnchorConfidence,
  visibleThreads,
} from '@site/store/slices/commentSelectors'
import type { CommentFilter } from '@site/store/slices/commentsSlice'
import type { CommentThread } from '@core/studio-comments'
import { SearchBar } from '@ui/components/SearchBar'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { EmptyState } from '@ui/components/EmptyState'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { cn } from '@ui/cn'
import { deleteThreadsById, sendThreadsToAgent } from '@site/studio/commentBulkActions'
import styles from './CommentsPanel.module.css'

const FILTERS: ReadonlyArray<{ value: CommentFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
]

function CommentRow({ thread }: { thread: CommentThread }) {
  const activeThreadId = useEditorStore((s) => s.activeThreadId)
  const setActiveCommentThread = useEditorStore((s) => s.setActiveCommentThread)
  const setActiveBoard = useEditorStore((s) => s.setActiveBoard)
  const confidence = useEditorStore((s) => selectThreadAnchorConfidence(s, thread))
  const selected = useEditorStore((s) => s.selectedThreadIds.includes(thread.id))
  const toggleThreadSelected = useEditorStore((s) => s.toggleThreadSelected)
  const first = thread.comments[0]
  const replies = thread.comments.length - 1

  return (
    <li className={styles.rowShell}>
      <Checkbox
        boxSize="sm"
        className={styles.rowCheck}
        checked={selected}
        aria-label={`Select comment ${thread.seq}`}
        onCheckedChange={() => toggleThreadSelected(thread.id)}
      />
      <Button
        variant="ghost"
        size="sm"
        className={cn(styles.row, thread.id === activeThreadId && styles.rowActive)}
        onClick={() => {
          // A thread can live on a board that is not the one on screen. Switch
          // first, or "open" would silently do nothing for half the list.
          if (thread.boardId) setActiveBoard(thread.boardId)
          setActiveCommentThread(thread.id)
        }}
      >
        <span className={cn(styles.seq, thread.resolved && styles.seqResolved)}>{thread.seq}</span>
        <span className={styles.rowBody}>
          <span className={styles.rowHead}>
            <span className={styles.author}>{first?.author.displayName ?? 'Unknown'}</span>
            {first?.author.kind === 'agent' ? <span className={styles.agentTag}>AI</span> : null}
            {confidence === 'detached' || confidence === 'drifted' ? (
              <span className={styles.stale}>stale</span>
            ) : null}
          </span>
          <span className={styles.preview}>{first?.body ?? ''}</span>
          {replies > 0 ? (
            <span className={styles.meta}>
              {replies} {replies === 1 ? 'reply' : 'replies'}
            </span>
          ) : null}
        </span>
      </Button>
    </li>
  )
}

/** The bar that replaces the filter row while a selection exists. */
function BulkActionBar({ threads }: { threads: readonly CommentThread[] }) {
  const selectedIds = useEditorStore((s) => s.selectedThreadIds)
  const clearSelectedThreads = useEditorStore((s) => s.clearSelectedThreads)
  const selected = threads.filter((thread) => selectedIds.includes(thread.id))

  return (
    <div className={styles.bulkBar} role="group" aria-label="Bulk comment actions">
      <span className={styles.bulkCount}>{selected.length} selected</span>
      <Button variant="secondary" size="sm" onClick={() => void sendThreadsToAgent(selected)}>
        Send to AI
      </Button>
      <Button
        variant="secondary"
        size="sm"
        tone="danger"
        onClick={() => void deleteThreadsById(selected.map((thread) => thread.id))}
      >
        Delete
      </Button>
      <Button variant="ghost" size="sm" onClick={clearSelectedThreads}>
        Cancel
      </Button>
    </div>
  )
}

export function CommentsPanel() {
  // Stored references only, filtered here in the body rather than inside a
  // selector — a selector that builds the filtered array re-renders forever
  // (see `commentSelectors.ts`'s header). The React Compiler memoizes this.
  const allThreads = useEditorStore((s) => s.comments.threads)
  const filter = useEditorStore((s) => s.commentFilter)
  const setCommentFilter = useEditorStore((s) => s.setCommentFilter)
  const search = useEditorStore((s) => s.commentSearch)
  const setCommentSearch = useEditorStore((s) => s.setCommentSearch)
  const loadFailed = useEditorStore((s) => s.commentsLoadFailed)
  const selectedIds = useEditorStore((s) => s.selectedThreadIds)
  const setSelectedThreads = useEditorStore((s) => s.setSelectedThreads)
  const clearSelectedThreads = useEditorStore((s) => s.clearSelectedThreads)
  const setCommentsPaneOpen = useEditorStore((s) => s.setCommentsPaneOpen)

  const threads = visibleThreads(allThreads, filter, search)
  const totalThreads = allThreads.length
  const allVisibleSelected = threads.length > 0 && threads.every((t) => selectedIds.includes(t.id))

  return (
    <div className={styles.panel} data-testid="comments-panel">
      {/*
        The pane has no rail button — it is entered from the canvas (`C`, the
        Comment tool, or a pin) — so it has to carry its own way out.
      */}
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Comments</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close comments"
          onClick={() => setCommentsPaneOpen(false)}
        >
          ✕
        </Button>
      </header>

      <div className={styles.controls}>
        <SearchBar
          value={search}
          onValueChange={setCommentSearch}
          placeholder="Search comments"
          aria-label="Search comments"
        />
        {selectedIds.length > 0 ? (
          <BulkActionBar threads={allThreads} />
        ) : (
          <SegmentedControl<CommentFilter>
            value={filter}
            options={FILTERS}
            onChange={setCommentFilter}
          />
        )}
      </div>

      {loadFailed ? (
        <EmptyState
          title="Comments unavailable"
          description="The comment file could not be read. Reload the project to try again."
        />
      ) : threads.length === 0 ? (
        <EmptyState
          title={totalThreads === 0 ? 'No comments yet' : 'Nothing matches'}
          description={
            totalThreads === 0
              ? 'Press C, then click anywhere on the board to leave a comment.'
              : 'No thread matches this filter and search.'
          }
        />
      ) : (
        <>
          <label className={styles.selectAll}>
            <Checkbox
              boxSize="sm"
              checked={allVisibleSelected}
              onCheckedChange={(next) =>
                next ? setSelectedThreads(threads.map((t) => t.id)) : clearSelectedThreads()
              }
            />
            <span>Select all {threads.length}</span>
          </label>
          <ol className={styles.list}>
            {threads.map((thread) => (
              <CommentRow key={thread.id} thread={thread} />
            ))}
          </ol>
        </>
      )}
    </div>
  )
}
