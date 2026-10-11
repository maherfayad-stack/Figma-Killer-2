/**
 * structuralWriteRetry — a structural write that could not REACH the server is
 * tried again, quietly, before anything is taken back (ERR-6).
 *
 * The failure this is for is the dev server restarting under a drag (`dev-04`:
 * `bun --watch` restarts on a file change, often the very file the last write
 * touched), or a network blip. Neither is the user's doing, and neither says
 * anything about whether the gesture was a good one. Rolling the canvas back
 * the instant `fetch` rejects turned a two-second restart into a lost drag and
 * an error toast.
 *
 * `@core/http` already rides out the dev proxy's empty 502/503/504 for this
 * route (its own ~5 s ladder). What it does not retry is a request that got no
 * response at all — `fetch` rejecting with a `TypeError` — and a gateway
 * status that outlived its ladder. This covers both, on
 * {@link STRUCTURAL_WRITE_RETRY_BACKOFF_MS}, through the one shared ladder
 * (`@core/http`'s `retryWhileUnreachable`) every quiet retry in the editor uses.
 *
 * ONE idempotency key for every attempt. "No response" does not mean "not
 * written": a handler can finish its codemod and die before answering. The
 * save route records each key's answer on disk
 * (`server/handlers/studio/idempotentReplay.ts`), so an attempt whose
 * predecessor landed gets that answer back instead of moving or deleting a
 * second time.
 *
 * A response the server DID construct — a refusal, a 4xx, a 500 envelope — is
 * an answer, never retried: the same request would get the same answer.
 */
import { retryWhileUnreachable } from '@core/http'
import type { IdentityCapture } from './sourceIdentity'
import { postEdits, type PostEditsOptions } from './studioSaveRequests'

/** Waits before retry 1, 2 and 3; the length is the budget. Short: the board is showing an unconfirmed change meanwhile. */
const STRUCTURAL_WRITE_RETRY_BACKOFF_MS = [1000, 2000, 4000] as const

/** `postEdits`, retried on `@core/http`'s `isUnreachableFailure` with one idempotency key across attempts. Throws the last failure. */
export async function postEditsRetryingUnreachable(
  edits: readonly Record<string, unknown>[],
  identities: IdentityCapture,
  options: PostEditsOptions = {},
): Promise<Awaited<ReturnType<typeof postEdits>>> {
  const idempotencyKey = crypto.randomUUID()
  return retryWhileUnreachable(() => postEdits(edits, identities, idempotencyKey, options), {
    backoffMs: STRUCTURAL_WRITE_RETRY_BACKOFF_MS,
  })
}
