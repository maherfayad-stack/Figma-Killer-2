/**
 * elementMovedRecovery — what the board does when the server refuses a write
 * `element-moved` (P1-A): the file changed since the board read it, so the
 * position an edit named now holds a different element, and nothing was
 * written there.
 *
 * That is not the user's mistake and it is not an error they can act on, so it
 * is never shown as one. The recovery is one attempt, silent when it works:
 *
 *   1. Re-read the files the refused write touched, and wait until the board
 *      actually has them (a narrow patch applies at once; a full reload lands
 *      whenever it lands — `waitForBoardRead` covers both).
 *   2. Re-find every element the write named, by the identity captured when
 *      the user acted (`relocateCapturedIds`). Each must be exactly one
 *      position in its file; anything else is a guess, and a guess is how the
 *      wrong element got written in the first place.
 *   3. Hand the rewritten edits back to the caller, who posts them through its
 *      own path — a structural commit re-enters `commitStructuralBody`, the
 *      autosave re-posts its value edits, a one-shot re-posts its one edit.
 *      One recovery, every writer; no second writer.
 *
 * Only when step 1 or 2 fails, or the retry is refused `element-moved` again,
 * does the user see anything — exactly one warning, which says what happened
 * and that nothing was written ({@link warnElementMoved}).
 */
import { ELEMENT_MOVED_REASON, sourceLocationKey } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { resyncBoardAfterWrite } from './studioBoardResync'
import { relocateCapturedIds, waitForBoardRead, type IdentityCapture, type SourceIdentity } from './sourceIdentity'
import { fileOfNodeId, remapStructuralEditIds, structuralEditNodeIds, type StructuralEditPayload } from './structuralUndoPlan'

/** How long a recovery waits for the board to re-read the changed files before giving up honestly. */
const BOARD_READ_TIMEOUT_MS = 10_000

/** The node ids of the edits the server refused `element-moved`. */
export function elementMovedNodeIds(refusals: readonly { nodeId: string; reason: string }[] | undefined): Set<string> {
  return new Set((refusals ?? []).filter((refusal) => refusal.reason === ELEMENT_MOVED_REASON).map((r) => r.nodeId))
}

/**
 * Steps 1 and 2 of this module's doc: re-read `touchedFiles`, then re-find
 * every element `edits` name. Returns the edits rewritten against the fresh
 * board and the same identities keyed by their new ids, or `null` when the
 * board did not catch up or any element cannot be found exactly once.
 */
export async function replanAfterElementMoved<T extends StructuralEditPayload>(
  edits: readonly T[],
  identities: IdentityCapture,
  touchedFiles: readonly string[],
): Promise<{ edits: T[]; identities: IdentityCapture } | null> {
  const boardRead = waitForBoardRead(BOARD_READ_TIMEOUT_MS)
  await resyncBoardAfterWrite(touchedFiles)
  if (!(await boardRead)) return null
  const relocated = relocateCapturedIds(identities, edits.flatMap((edit) => structuralEditNodeIds(edit)))
  if (!relocated) return null
  const rekeyed = new Map<string, SourceIdentity>()
  for (const [nodeId, identity] of identities) rekeyed.set(relocated.get(nodeId) ?? nodeId, identity)
  return { edits: remapStructuralEditIds([...edits], relocated) as T[], identities: rekeyed }
}

/**
 * The whole recovery for a writer that posts a plain batch (the autosave diff,
 * a one-shot commit): re-plan `movedEdits` and post them once through `post`.
 * Returns the retry's response, or `null` when there was nothing honest to
 * retry against. Never shows anything — the caller owns its one message,
 * because only it knows whether a refusal already has a surface (a one-shot's
 * panel) or needs {@link warnElementMoved}.
 */
export async function retryAfterElementMoved<T extends StructuralEditPayload, R>(
  movedEdits: readonly T[],
  identities: IdentityCapture,
  touchedFiles: readonly string[],
  post: (edits: T[], identities: IdentityCapture) => Promise<R>,
): Promise<R | null> {
  const replan = await replanAfterElementMoved(movedEdits, identities, touchedFiles)
  return replan ? post(replan.edits, replan.identities) : null
}

/**
 * The one visible outcome: the element could not be found again, so nothing
 * was written. A warning, not an error — the file is fine and the board now
 * shows it as it is; the edit simply had nowhere honest to land.
 */
export function warnElementMoved(nodeIds: Iterable<string>): void {
  const files = [...new Set([...nodeIds].map((nodeId) => fileOfNodeId(sourceLocationKey(nodeId) ?? nodeId)))]
  pushToast({
    kind: 'warning',
    title: 'Not saved — the file changed',
    body: `${files.join(', ')} changed outside Studio, and the element you edited is no longer where it was, so nothing was written. The board now shows the file as it is on disk; make the change again there.`,
    location: 'site-editor',
  })
}
