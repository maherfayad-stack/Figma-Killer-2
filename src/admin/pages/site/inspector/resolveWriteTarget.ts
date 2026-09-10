/**
 * resolveWriteTarget — "the write target is a rule, not a mode" (Track P, P1).
 *
 * `STUDIO-LIVE-CANVAS-PLAN.md` §P1: a commit lands by ONE rule — the most
 * specific writable source that already sets this property; otherwise the
 * element's own class if it has exactly one editable class; otherwise
 * inline. This module is that rule, and nothing else.
 *
 * ## Explicitly disposable scaffolding
 *
 * `STATE.md` (`panel-21`) is explicit: this is the minimum-viable version of
 * the rule, and P4's `SelectionModel` / `commitStyle` unification REPLACES
 * it wholesale rather than extending it. Accordingly this module has no
 * preview channel, no coalescing across a multi-property patch, and no
 * per-field override menu — a caller writing several properties in one
 * gesture (`onChangeMany`) resolves the target once, from the first key in
 * the patch, and writes the whole patch there. Do not grow this file to
 * cover those cases; P4 owns that shape.
 *
 * ## "Most specific" is what `stylePropertyProvenance.ts` already decided
 *
 * `PropertyProvenance.sources` already encodes CSS specificity honestly: an
 * inline declaration always outranks every class declaration, and among
 * multiple class declarations the `winner` is crowned only when it can be
 * attributed HONESTLY (see that module's doc). So "the most specific
 * writable source that already sets this property" is simply: take the
 * provenance winner, and use it if it is writable. An `ambiguous` property
 * (multiple classes disagree, no honest winner) has no source here — which
 * is correct: this rule must never guess which of several class
 * declarations a value belongs to.
 */
import type { PropertyProvenance } from '../panels/PropertiesPanel/stylePropertyProvenance'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WriteTargetClassCandidate {
  classId: string
  /** Human-readable selector, e.g. `.card` — for the chip/notice copy only. */
  selector: string
}

export interface ResolveWriteTargetParams {
  /** This property's provenance (winner + every declared source), if computed. */
  provenance: PropertyProvenance | undefined
  /** Whether a NEW inline declaration for this property would reach disk. */
  inlineWritable: boolean
  /**
   * Every class assigned to the node whose declarations for THIS property
   * would reach disk (already filtered for generated-utility-lock /
   * compiled / unmapped — see `classCssWritability.ts`).
   */
  writableClasses: ReadonlyArray<WriteTargetClassCandidate>
}

export type WriteTarget =
  | { kind: 'inline' }
  | { kind: 'class'; classId: string; selector: string }
  /** No honest target exists for a NEW declaration of this property. */
  | { kind: 'none'; reason: string }

const NO_TARGET_REASON =
  'Nothing here can save this — the element has no writable class and its inline styles are locked.'

/**
 * The forward-looking rule, used for a WRITE of a new or changed value.
 */
export function resolveWriteTarget(params: ResolveWriteTargetParams): WriteTarget {
  const { provenance, inlineWritable, writableClasses } = params

  const winner = provenance?.sources.find((source) => source.winner)
  if (winner) {
    if (winner.kind === 'inline') {
      if (inlineWritable) return { kind: 'inline' }
    } else {
      const match = writableClasses.find((c) => c.classId === winner.classId)
      if (match) return { kind: 'class', classId: match.classId, selector: match.selector }
    }
    // The winning source exists but is not writable (a locked class, or a
    // structurally-locked inline layer) — fall through to the default rule
    // below rather than silently rewriting a DIFFERENT source than the one
    // that is actually rendering.
  }

  if (writableClasses.length === 1) {
    return { kind: 'class', classId: writableClasses[0].classId, selector: writableClasses[0].selector }
  }
  if (inlineWritable) return { kind: 'inline' }
  return { kind: 'none', reason: NO_TARGET_REASON }
}

/**
 * The backward-looking rule, used for REMOVING/clearing an existing value —
 * there is nothing to fall back to: either something already declares this
 * property honestly (remove it there) or there is nothing this control may
 * touch.
 */
export function resolveExistingWriteTarget(params: {
  provenance: PropertyProvenance | undefined
  inlineWritable: boolean
  writableClasses: ReadonlyArray<WriteTargetClassCandidate>
}): WriteTarget {
  const { provenance, inlineWritable, writableClasses } = params
  const winner = provenance?.sources.find((source) => source.winner)
  if (!winner) return { kind: 'none', reason: 'Nothing declares this property.' }
  if (winner.kind === 'inline') {
    return inlineWritable
      ? { kind: 'inline' }
      : { kind: 'none', reason: 'This value is set from the source file and cannot be removed here.' }
  }
  const match = writableClasses.find((c) => c.classId === winner.classId)
  return match
    ? { kind: 'class', classId: match.classId, selector: match.selector }
    : { kind: 'none', reason: 'This value is set by a class Studio cannot write to.' }
}
