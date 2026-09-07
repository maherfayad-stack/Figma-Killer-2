/**
 * Picking WHICH registered design reference a tool call means, and how its
 * pixels relate to CSS px.
 *
 * Extracted from `compare.ts` when `measureReference.ts` needed the identical
 * rule. Both tools are addressed the same way by the agent — name the screen,
 * let the reference follow — so the precedence has to be one implementation.
 * Two copies would drift into two tools that disagree about which design they
 * are talking about, which is the most confusing failure this surface could
 * have.
 *
 * ## Why this is no longer "the most recently registered one"
 *
 * It used to be: this page's own reference, else the most recent reference
 * anywhere in the project. That rule was written when a reference could only
 * arrive by a deliberate act. Then `registerTurnDesignReferences` started
 * registering EVERY chat-attached image durably — which is right, an attached
 * design should arm the ruler — and "most recent" quietly became "whatever
 * the user last pasted". A screenshot pasted to ask a question ("why does
 * this look wrong?") outranked the Figma frame the page was built from, and
 * `studio_compare` spent the rest of the project measuring the wrong image
 * with full confidence. In this repo's own `test4` fixture it is worse than
 * wrong: the `sms` page's 375x800 Figma frame is shadowed by a 943x294 chat
 * crop, so compare refuses on aspect ratio and the Stop gate can never pass
 * again.
 *
 * The precedence is now two axes, role first:
 *
 *   1. `spec` scoped to this page      — the design, named for this screen
 *   2. `spec` with no page scope       — the design, project-wide
 *   3. `context` scoped to this page   — an image from the conversation
 *   4. `context` with no page scope    — an image from the conversation
 *
 * Role is the primary axis because it answers a different question than page
 * scope does: scope says which screen an image is ABOUT, role says whether it
 * is a design at all. A deliberately registered Figma export always beats a
 * pasted crop, even an unscoped export against a page-scoped crop.
 *
 * A reference scoped to a DIFFERENT page never appears in any tier. "The most
 * recent reference in the project" was how screen 2's comp came to be
 * measured against screen 1, and a design registered for another screen is
 * not this screen's spec by any reading.
 *
 * ## Why more than one candidate is a refusal
 *
 * The first non-empty tier decides, and if it holds more than one candidate
 * this refuses by name instead of picking. There is no tie-break that is
 * right: "newest" is exactly the rule that produced the bug above, and
 * "oldest" fails the user who registered a corrected export. The agent is
 * holding the one piece of information that settles it — which screen it is
 * working on and which image the user meant — so the refusal hands it the
 * candidate list and the `referenceId` argument that ends the ambiguity, and
 * it costs one tool call rather than a whole project measured against the
 * wrong picture.
 *
 * A single `context` image still resolves, so "paste a comp, build the
 * screen" keeps working. What no longer happens is a silent choice between
 * two of them.
 */
import { authoredFrameWidth } from '../../../../handlers/studio/boardGeometry'
import {
  getDesignReference,
  readAllDesignReferences,
} from '../../../../handlers/studio/designReferenceStore'
import {
  designReferenceRole,
  type DesignReference,
  type DesignReferenceRole,
} from '../../../../handlers/studio/designReferenceSchema'

/**
 * Why resolution failed, for the one caller that must act differently per
 * cause. `pageWriteVerification.ts` turns this into the sentence the Stop-hook
 * gate blocks with, and "register a design reference" is the wrong instruction
 * for a page that already has two — it would send the agent to add a third.
 * Every other caller just surfaces `error`.
 */
export type ResolveReferenceFailure =
  /** `referenceId` named something that is not registered. */
  | 'unknown-id'
  /** The top-ranked tier held more than one candidate. `referenceId` settles it. */
  | 'ambiguous'
  /** References exist, but every one is scoped to a different page. */
  | 'other-pages-only'
  /** Nothing is registered for this project at all. */
  | 'none'

export type ResolveReferenceResult =
  | { ok: true; reference: DesignReference; implicit: boolean; role: DesignReferenceRole }
  | { ok: false; failure: ResolveReferenceFailure; error: string }

/** `<id> 375x800 "SMS — Figma"` — enough for the agent to pick one without a second list call. */
function describeCandidate(reference: DesignReference): string {
  const label = reference.label ? ` "${reference.label}"` : ''
  const source = reference.source ? ` from ${reference.source}` : ''
  return `${reference.id} ${reference.width}x${reference.height}${label}${source}`
}

/**
 * The refusal for a page with several equally-ranked candidates. Names every
 * one of them, names the argument that settles it, and — for the
 * chat-attachment case, which is how this happens in practice — names the
 * cleanup that stops it happening again.
 */
function ambiguousMessage(
  pageId: string,
  role: DesignReferenceRole,
  candidates: readonly DesignReference[],
): string {
  const list = candidates.map(describeCandidate).join('; ')
  const head =
    role === 'spec'
      ? `"${pageId}" has ${candidates.length} registered designs and no way to tell which one it is supposed to match`
      : `"${pageId}" has no registered design, and ${candidates.length} images from this conversation that could stand in for one`
  const tail =
    role === 'spec'
      ? 'Pass referenceId to name the one to measure against.'
      : 'None of these was registered as a design — every image attached to chat is kept as "context". Pass referenceId to measure against the one that really is the design, or register the actual export with studio_register_design_reference (pageId:"' + pageId + '") so this stops being a question on every call.'
  return `${head}, so this was not guessed: ${list}. ${tail}`
}

/**
 * The reference to work against — see the module doc for the precedence and
 * why an ambiguous page is refused rather than guessed.
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
      return { ok: false, failure: 'unknown-id', error: `No design reference "${referenceId}" is registered for this project — call studio_list_design_references to see what is.` }
    }
    // An explicit id is the explicit gesture: it promotes a `context` image to
    // the spec for this call, which is exactly the escape hatch every refusal
    // below points at.
    return { ok: true, reference: explicit, implicit: false, role: designReferenceRole(explicit) }
  }

  const all = readAllDesignReferences(dir)
  const tiers: ReadonlyArray<{ role: DesignReferenceRole; candidates: DesignReference[] }> = [
    { role: 'spec', candidates: all.filter((r) => designReferenceRole(r) === 'spec' && r.pageId === pageId) },
    { role: 'spec', candidates: all.filter((r) => designReferenceRole(r) === 'spec' && r.pageId === undefined) },
    { role: 'context', candidates: all.filter((r) => designReferenceRole(r) === 'context' && r.pageId === pageId) },
    { role: 'context', candidates: all.filter((r) => designReferenceRole(r) === 'context' && r.pageId === undefined) },
  ]

  for (const tier of tiers) {
    if (tier.candidates.length === 0) continue
    if (tier.candidates.length > 1) {
      return { ok: false, failure: 'ambiguous', error: ambiguousMessage(pageId, tier.role, tier.candidates) }
    }
    return { ok: true, reference: tier.candidates[0]!, implicit: true, role: tier.role }
  }

  // Nothing this page could use. Distinguish "no designs exist" from "designs
  // exist, all belonging to other screens" — the second sounds like the first
  // to an agent that just saw them listed in the digest, and answering it with
  // the generic "register one" message reads as a bug in Studio rather than
  // the deliberate refusal it is.
  const otherPages = all.filter((r) => r.pageId !== undefined && r.pageId !== pageId)
  if (otherPages.length > 0) {
    const list = otherPages.map((r) => `${r.id} → ${r.pageId}`).join('; ')
    return {
      ok: false,
      failure: 'other-pages-only',
      error:
        `There is no design reference registered for "${pageId}". ${otherPages.length} reference(s) are registered, but every one of them is scoped to a different screen (${list}), and another screen's design is not this screen's spec — measuring against it would produce a confident wrong number. Register this page's own design with studio_register_design_reference (pageId:"${pageId}"), or pass referenceId explicitly if one of those really is the design for this page.`,
    }
  }

  return {
    ok: false,
    failure: 'none',
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
