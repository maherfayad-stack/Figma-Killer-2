/**
 * turnDesignReferences — an image attached to a chat turn with a Studio
 * project open IS the design to match, so it gets registered as a durable
 * design reference before the turn runs.
 *
 * ## The gap this closes
 *
 * `studio_compare` is stated in the Studio system prompt as the definition of
 * done: "a screen with a registered reference is DONE when studio_compare
 * returns pass:true, and not one turn before." That sentence was load-bearing
 * and, in practice, unreachable — because nothing armed the ruler.
 *
 * A design reached the agent one of two ways, and only one of them counted:
 *
 *   - Through the composer's DESIGN REFERENCE affordance
 *     (`DesignReferenceAttachment.tsx` -> `POST /admin/api/studio/
 *     reference-upload`), which registers durably. A deliberate, separate,
 *     easily-missed control.
 *   - As an ORDINARY chat image attachment — drag, paste, screenshot — which
 *     went to the model as a transient image block and left nothing on disk.
 *
 * The second is what people actually do. On a real project whose five screens
 * were built from a pasted comp, `.studio/references/` did not exist at all:
 * `studio_compare` would have answered "there is no design reference
 * registered for this project", the agent measured nothing, and it reported
 * the screens as done by eye. Every failure that follows from that — a button
 * fill that is close but wrong, type two steps up the scale, an icon that
 * never rendered — was invisible because nothing was ever measured against
 * anything.
 *
 * So the transient path now feeds the durable one. Attaching a design is
 * enough; there is no second control to remember.
 *
 * ## Why it takes the turn's active page id
 *
 * Every reference used to register with NO `pageId`, so it could never win
 * `resolveDesignReference`'s ("this page's own" beats "most recent
 * project-wide") branch — only the explicit-id and most-recent-project-wide
 * fallbacks ever fired. Paste screen 1's comp, build it, then paste screen
 * 2's comp anywhere later in the SAME conversation, and every subsequent
 * `studio_compare`/`studio_measure_reference` call for screen 1 silently
 * started measuring against screen 2's design instead — the literal flagship
 * workflow (paste several frames, build several screens) failing with a
 * confident, wrong number instead of an error.
 *
 * `pageId` here is the turn's live active-page id, threaded in by the caller
 * from the same `StudioAgentSnapshot.activePageId` the live digest is already
 * built from (`chat.ts`) — never re-derived by a second, possibly-stale path.
 * `undefined` when no Studio project is open or the browser posted no/an
 * invalid snapshot; the reference then registers unscoped and only the
 * explicit-id / most-recent-project-wide fallbacks can find it again, exactly
 * as before this fix — an honest degradation, not a silent wrong answer.
 *
 * ## Why it is idempotent by content hash
 *
 * This runs on EVERY turn, and a conversation re-sends its attachments as the
 * user keeps talking about the same screen. Registering unconditionally would
 * write one copy of the same comp per turn — a 2 MB PNG times twenty turns of
 * "make the button bigger" — and leave `studio_compare`'s
 * most-recently-registered fallback pointing at a fresh duplicate every time.
 * `findDesignReferenceByContentHash` makes re-attaching the same bytes a
 * no-op that still returns the existing reference, so the caller can report
 * what is armed without caring which turn armed it.
 *
 * ## Why it lives here and not under `server/ai/handlers/`
 *
 * It is turn-shaped policy, so `server/ai/handlers/` reads like the obvious
 * home — but everything in that directory is an HTTP route handler, which
 * `ai-handlers-capability-gated.test.ts` enforces by requiring every file
 * there to call `requireCapability`. This is a helper the chat handler calls
 * AFTER its own gate, and it is the third writer into
 * `designReferenceStore` (beside `referenceUpload.ts`'s HTTP route and
 * `designReferenceTools.ts`'s MCP tool), so it belongs beside the store.
 *
 * ## Why it never fails the turn
 *
 * Arming is a convenience, not a precondition. A reference that cannot be
 * registered (an unreadable image, a full disk, an SVG — which the store
 * refuses outright, having no fixed pixel size to diff against) must not stop
 * the user's actual request from running. Failures are logged and dropped;
 * the turn proceeds with whatever armed successfully, which may be nothing.
 */
import { createHash } from 'node:crypto'
import type { DesignReference } from './designReferenceSchema'
import { findDesignReferenceByContentHash, registerDesignReference } from './designReferenceStore'

/** `source` recorded on a reference armed from a chat attachment, so a human reading the manifest back can tell it apart from a deliberate `studio_register_design_reference` call. */
export const CHAT_ATTACHMENT_REFERENCE_SOURCE = 'chat-attachment'

/**
 * Register every image attached to this turn as a design reference, skipping
 * any whose bytes are already registered. Returns what is now armed, in
 * attachment order — existing entries included, so the caller sees the full
 * set regardless of which turn first registered them.
 *
 * `pageId` scopes freshly-registered references to the page the user was
 * looking at when they pasted the image — see the module doc's "Why it takes
 * the turn's active page id". An already-registered match (by content hash)
 * is returned as-is and never re-scoped by a later paste of the same bytes.
 *
 * Never throws.
 */
export async function registerTurnDesignReferences(
  dir: string,
  imageBytes: readonly Uint8Array[],
  pageId?: string,
): Promise<DesignReference[]> {
  const armed: DesignReference[] = []

  for (const [index, bytes] of imageBytes.entries()) {
    const contentHash = createHash('sha256').update(bytes).digest('hex')

    const existing = findDesignReferenceByContentHash(dir, contentHash)
    if (existing) {
      armed.push(existing)
      continue
    }

    try {
      const result = await registerDesignReference(dir, bytes, {
        label: imageBytes.length > 1 ? `Attached in chat (${index + 1})` : 'Attached in chat',
        source: CHAT_ATTACHMENT_REFERENCE_SOURCE,
        ...(pageId ? { pageId } : {}),
      })
      if (!result.ok) {
        // Expected for an SVG or an undecodable attachment. The turn still runs.
        console.warn('[turnDesignReferences] could not arm an attached image:', result.error)
        continue
      }
      armed.push(result.reference)
    } catch (err) {
      console.error('[turnDesignReferences]', err)
    }
  }

  return armed
}
