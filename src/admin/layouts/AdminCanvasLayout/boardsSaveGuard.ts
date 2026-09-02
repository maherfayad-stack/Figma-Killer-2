/**
 * boardsSaveGuard — the last-line-of-defense check behind
 * `AdminCanvasLayout.tsx`'s `useStudioBoardsPersistence` autosave: refuse to
 * `POST /admin/api/studio/boards` when the payload about to be written would
 * silently drop a frame the store last confirmed was really on disk.
 *
 * **Why this exists.** `STATE.md` → `store-02` fixed ONE way `boardsDirty`
 * could be set from state that does not reflect the real on-disk file (a
 * failed boards fetch treated as an empty project). That fix closes the
 * exact trigger that fired once, but the underlying pattern — `boardsDirty`
 * → an 800ms debounce → a whole-file overwrite — stays live for ANY other way
 * the in-memory `boards` can end up missing frames the file on disk actually
 * has (a race between two overlapping loads after a fast project switch, a
 * second tab, a future bug nobody has written yet). The incident this
 * protects against was diagnosed by its SHAPE — `.studio/boards.json` was
 * rewritten with a reduced frame set — so this guard checks exactly that
 * shape, independent of which trigger produced it.
 *
 * **The check.** Every successful load or save establishes a new
 * "known-good" frame-id baseline (`AdminCanvasLayout.tsx` keeps it in a ref).
 * Immediately before a save, compare the baseline against the frame ids the
 * save is about to write: if the baseline names a frame id the outgoing
 * payload no longer has, AND nothing in this dirty window was an EXPLICIT
 * user removal (`boardSlice.ts`'s `boardsPendingExplicitRemoval` — set by
 * `removeFrame` / `removeFrameById` / `removeBoard`, and by `patchPages`'s
 * own frame cleanup for a genuinely-deleted page), the save is refused.
 *
 * **What this deliberately does NOT do.** It does not diff/merge against a
 * fresh server read before every save (an extra round trip on every 800ms
 * tick) and it does not require a server-side generation/etag (the server
 * contract is out of scope for this change — see `STATE.md`). It is a
 * content-level invariant enforceable entirely client-side: "don't write a
 * file that is missing something the store itself once confirmed was real,
 * unless the user just removed it on purpose."
 *
 * **What it does NOT catch.** A same-size or superset frame swap (ids
 * replaced 1:1) is not a "subset" and passes through — this guard is
 * specifically the "boards.json rewritten with a reduced frame set" shape,
 * not a general corruption detector. A genuine two-tab last-write-wins race
 * (both tabs hold a full, real frame set, one just overwrites the other's
 * later edit) is a known, unclosed gap — it needs server-side coordination
 * (an ETag/generation the server rejects a stale base against), which is
 * explicitly out of scope here (no `server/` edits in this change).
 */
import type { BoardsFile } from '@core/studio-board'

/** Every `BoardFrame.id` across every board in the file — the atomic unit a "removal" is measured in (WS-10 Phase 2: a duplicated variant has its OWN frame id sharing a `pageId`, so `pageId` alone would under-count). */
export function collectFrameIds(file: BoardsFile): Set<string> {
  const ids = new Set<string>()
  for (const board of file.boards) {
    for (const frame of board.frames) ids.add(frame.id)
  }
  return ids
}

export interface BoardsSaveGuardInputs {
  /** Frame ids as of the last successful load or save — `null` before any baseline exists (nothing to compare against yet, e.g. the very first save of a session). */
  baselineFrameIds: ReadonlySet<string> | null
  /** Frame ids the save is ABOUT to write. */
  nextFrameIds: ReadonlySet<string>
  /** `boardSlice.ts`'s `boardsPendingExplicitRemoval` — true when a real user (or a confirmed-deleted-page cleanup) removed a frame since the last successful save. */
  explicitRemovalPending: boolean
}

/**
 * True when `nextFrameIds` is missing at least one id `baselineFrameIds` had,
 * and nothing in the current dirty window explains that removal. An empty or
 * absent baseline never refuses (nothing confirmed-real to lose yet) — this
 * is what keeps a genuinely new project's first save, and the very first
 * "apply to all pages" seed, unaffected.
 */
export function shouldRefuseBoardsSave(inputs: BoardsSaveGuardInputs): boolean {
  if (inputs.explicitRemovalPending) return false
  if (!inputs.baselineFrameIds || inputs.baselineFrameIds.size === 0) return false
  for (const id of inputs.baselineFrameIds) {
    if (!inputs.nextFrameIds.has(id)) return true
  }
  return false
}
