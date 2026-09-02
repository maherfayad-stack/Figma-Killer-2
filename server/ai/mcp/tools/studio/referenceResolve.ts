/**
 * Picking WHICH registered design reference a tool call means, and how its
 * pixels relate to CSS px.
 *
 * Extracted from `compare.ts` when `measureReference.ts` needed the identical
 * rule. Both tools are addressed the same way by the agent — name the screen,
 * let the reference follow — so the fallback order (explicit id, then the one
 * scoped to this page, then the most recently registered) has to be one
 * implementation. Two copies would drift into two tools that disagree about
 * which design they are talking about, which is the most confusing failure
 * this surface could have.
 */
import { authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
import {
  getDesignReference,
  listDesignReferences,
} from '../../../../handlers/studio/designReferenceStore'
import type { DesignReference } from '../../../../handlers/studio/designReferenceSchema'

export type ResolveReferenceResult =
  | { ok: true; reference: DesignReference; implicit: boolean }
  | { ok: false; error: string }

/**
 * The reference to work against: an explicit id, else this page's own, else
 * the most recent one registered for the project.
 *
 * The "no reference at all" message is deliberately long. It is the single
 * most consequential dead end on this surface — an agent that reads a short
 * refusal here goes back to judging by eye and reports the screen as done —
 * so it names the tool that fixes it, the argument to pass, and the one
 * honest alternative when the user genuinely supplied no design.
 */
export function resolveDesignReference(
  dir: string,
  pageId: string,
  referenceId: string | undefined,
): ResolveReferenceResult {
  if (referenceId !== undefined) {
    const explicit = getDesignReference(dir, referenceId)
    if (!explicit) {
      return { ok: false, error: `No design reference "${referenceId}" is registered for this project — call studio_list_design_references to see what is.` }
    }
    return { ok: true, reference: explicit, implicit: false }
  }

  const scoped = listDesignReferences(dir, pageId, undefined)
  const forPage = scoped.references[scoped.references.length - 1]
  if (forPage) return { ok: true, reference: forPage, implicit: true }

  const all = listDesignReferences(dir, undefined, undefined)
  const mostRecent = all.references[all.references.length - 1]
  if (mostRecent) return { ok: true, reference: mostRecent, implicit: true }

  return {
    ok: false,
    error:
      `There is no design reference registered for this project, so there is nothing to measure "${pageId}" against. If the user gave you a design — a Figma export, an attached image, a URL — register it with studio_register_design_reference (pass pageId:"${pageId}") and call this again. If they did not, say so rather than guessing at a score: without a reference, "does it match" has no answer.`,
  }
}

/**
 * CSS px per REFERENCE px, from the board frame's authored width.
 *
 * A comp exported at 2x holds a 21 CSS px heading as 42 pixels of ink.
 * Reporting the raw pixel count would hand back a number that is exactly as
 * wrong as the eyeballing it replaces, only with a measurement's authority —
 * so every length a measuring tool returns goes through this first.
 *
 * `null` when the page has no board frame, because there is then no authored
 * width to scale against and a guessed scale is worse than an honest refusal.
 */
export function cssPxPerReferencePx(dir: string, pageId: string, referenceWidth: number): number | null {
  const frameWidth = authoredFrameWidth(dir, pageId)
  if (frameWidth === null || frameWidth <= 0 || referenceWidth <= 0) return null
  return frameWidth / referenceWidth
}
