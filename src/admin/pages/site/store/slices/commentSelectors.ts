/**
 * commentSelectors — the read side of `commentsSlice`.
 *
 * Split out for the same reason `boardSelectors.ts` was: it keeps the slice
 * file to state + actions and gives every consumer one import for reading.
 *
 * EVERY `select*` HERE RETURNS A STORED REFERENCE OR A PRIMITIVE
 * ─────────────────────────────────────────────────────────────
 * Same rule `boardSelectors.ts` follows, and it is not a style preference.
 * Zustand reads a selector through `useSyncExternalStore`, so a selector that
 * BUILDS a value — `.filter(...)`, `.map(...)`, an object literal — hands React
 * a new reference on every snapshot read, React re-renders to catch up, reads
 * again, gets another new reference, and the component loops until React gives
 * up with "Maximum update depth exceeded". This file shipped exactly that bug
 * once: a `selectVisibleThreads` that filtered inside the selector took down
 * the whole editor body as soon as the project contained a single comment.
 *
 * So filtering a thread list is a RENDER-TIME derivation, not a selector.
 * `visibleThreads` below is a plain function over plain values: a component
 * subscribes to `comments.threads` / `commentFilter` / `commentSearch` — three
 * stored references — and derives in its body, where the React Compiler
 * memoizes it. `BoardCommentsLayer` already reads this way.
 * `comment-selector-stability.test.ts` is the gate.
 */
import type { EditorStore } from '@site/store/types'
import { resolveNodeAnchor, type AnchorConfidence } from '@core/studio-anchor'
import type { CommentThread } from '@core/studio-comments'
import type { CommentFilter } from './commentsSlice'

/** Stable "nothing here" reference — an inline `[]` would defeat every narrow selector below. */
const EMPTY_THREADS: readonly CommentThread[] = []

export const selectActiveCommentThread = (s: EditorStore): CommentThread | null =>
  s.activeThreadId === null
    ? null
    : (s.comments.threads.find((thread) => thread.id === s.activeThreadId) ?? null)

/** Count of open (unresolved) threads — the rail badge. */
export const selectOpenCommentCount = (s: EditorStore): number =>
  s.comments.threads.reduce((count, thread) => (thread.resolved ? count : count + 1), 0)

export function matchesCommentFilter(thread: CommentThread, filter: CommentFilter): boolean {
  if (filter === 'all') return true
  return filter === 'resolved' ? thread.resolved : !thread.resolved
}

/**
 * Free-text match across a thread's comments — bodies AND author names, so
 * "everything Sam said" is one query. Also matches the pin's own number, both
 * bare (`3`) and prefixed (`#3`), because that is how people refer to a thread
 * once they have one on screen.
 */
export function matchesCommentSearch(thread: CommentThread, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (needle.length === 0) return true
  if (String(thread.seq) === needle || `#${thread.seq}` === needle) return true
  return thread.comments.some(
    (comment) =>
      comment.body.toLowerCase().includes(needle) ||
      comment.author.displayName.toLowerCase().includes(needle),
  )
}

/**
 * The panel's list: filter + search applied, newest thread first.
 *
 * A plain function over plain values, NOT a store selector — see this file's
 * header for what happens when a filtered list is read through
 * `useEditorStore`. Call it in a component body from the three stored values.
 *
 * Newest-first rather than by `seq` because the panel is a work queue — the
 * comment someone just left is the one being reacted to. The canvas pins keep
 * their `seq` labels regardless, so the two views never disagree about a
 * thread's NAME, only about its order.
 */
export function visibleThreads(
  threads: readonly CommentThread[],
  filter: CommentFilter,
  search: string,
): readonly CommentThread[] {
  const matched = threads.filter(
    (thread) => matchesCommentFilter(thread, filter) && matchesCommentSearch(thread, search),
  )
  if (matched.length === 0) return EMPTY_THREADS
  return matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq)
}

/**
 * How much a thread's stored node hint can still be trusted, recomputed
 * against the page tree as it is RIGHT NOW.
 *
 * Never read from disk: a persisted confidence would be a claim about a tree
 * that has since changed, which is the exact failure this whole mechanism
 * exists to prevent. See `@core/studio-comments`'s `anchorResolve.ts`.
 *
 * A thread whose page is not currently loaded resolves `detached`. That is a
 * deliberate under-claim rather than an unknown state: the two consumers are
 * a badge (which should say "can't vouch for this" when it cannot) and the
 * agent gate (which must refuse when it cannot verify). Neither is improved
 * by a third value meaning "ask again later".
 *
 * A thread that never named an element resolves `unanchored`, NOT `detached`
 * — a pin dropped on empty canvas has lost nothing and must not wear a stale
 * badge. `resolveNodeAnchor` draws that line; this function must not
 * short-circuit around it.
 */
export function selectThreadAnchorConfidence(s: EditorStore, thread: CommentThread): AnchorConfidence {
  const pageId = thread.anchor.pageId
  if (!thread.anchor.node) return 'unanchored'
  if (!pageId) return 'unanchored'
  const page = s.site?.pages.find((candidate) => candidate.id === pageId)
  return resolveNodeAnchor(thread.anchor.node, page ?? null).confidence
}
