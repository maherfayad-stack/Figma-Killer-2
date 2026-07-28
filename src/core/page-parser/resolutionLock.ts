/**
 * resolutionLock — §7.6's wiring glue between `staticEval.ts`'s evaluator and
 * `parsePageFile.ts`'s node construction: turns a resolved `StaticValue` into
 * the prop/style/text value plus the lock + `ParsedNode.resolution` metadata
 * `processElement` attaches to a node. Split out of `parsePageFile.ts` purely
 * to stay under the module-size-budget ceiling — this is wiring glue, not new
 * evaluation logic (the evaluator itself lives in `staticEval.ts`).
 */
import type { Node } from 'ts-morph'
import { evaluateExpression, type EvalScope, type StaticEvalOptions, type StaticValue } from './staticEval'
import type { ParsedNode, ParsedPropValue } from './types'

/** The `(scope, options)` pair `parseJsxTree` builds once per page when the caller opts into §7 — see `ParseContext.eval` in `parsePageFile.ts`. */
export interface PageEvalContext {
  scope: EvalScope
  options: StaticEvalOptions
}

/** A resolved non-literal value, tracked alongside `props`/`inlineStyles`/`text` so `processElement` can lock the node and record `ParsedNode.resolution` — see its doc comment in `./types`. */
export interface Resolution {
  source: string
  note?: string
}

const MAX_RESOLUTION_SOURCE_LENGTH = 80

/** Caps + collapses whitespace in an expression's source text for a `lockReason`/`resolution.source` message — a resolved template literal can otherwise be arbitrarily long. */
function shortenSource(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_RESOLUTION_SOURCE_LENGTH
    ? `${collapsed.slice(0, MAX_RESOLUTION_SOURCE_LENGTH - 1)}…`
    : collapsed
}

/**
 * Attempts §7's evaluator fallback for one expression node, only when the
 * caller opted in (`evalCtx` present). Returns `undefined` on any miss
 * (unresolved, or opted out) so callers keep falling through to their
 * existing "skip it" behaviour unchanged.
 */
export function tryResolveExpression(
  expr: Node,
  evalCtx: PageEvalContext | undefined,
): { value: string | number | boolean; note?: string } | undefined {
  if (!evalCtx) return undefined
  const result: StaticValue = evaluateExpression(expr, evalCtx.scope, evalCtx.options)
  if (result.kind !== 'literal' || result.value === null) return undefined
  return { value: result.value, note: result.note }
}

/**
 * Converts a resolved `StaticValue` tree into the JSON-shaped `ParsedPropValue`
 * a component prop can carry, or `undefined` when nothing usable came back.
 *
 * Three deliberate rules, all about not lying about what the source says:
 *
 *  - A FUNCTION entry is dropped, never stubbed. `{ label, onClick }` becomes
 *    `{ label }`: the handler has no JSON form, and inventing a placeholder
 *    would make the canvas claim a behaviour the source does not have. The
 *    object is still worth keeping — the label is the part that renders.
 *  - An unresolved ARRAY ITEM declines the whole array. Rendering the resolvable
 *    half would silently drop a row, which reads as "the list is shorter" rather
 *    than "we could not read the list" — same rule `readStaticLoop` applies.
 *  - An OBJECT that ends up with no entries at all declines. An empty object is
 *    not information; a prop that resolved to nothing should stay absent so the
 *    component falls back to its own default.
 */
function staticValueToPropValue(value: StaticValue): ParsedPropValue | undefined {
  switch (value.kind) {
    case 'literal':
      return value.value === null ? undefined : value.value
    case 'array': {
      const items: ParsedPropValue[] = []
      for (const item of value.items) {
        const converted = staticValueToPropValue(item)
        if (converted === undefined) return undefined
        items.push(converted)
      }
      return items
    }
    case 'object': {
      const entries: Record<string, ParsedPropValue> = {}
      for (const [key, entry] of value.entries) {
        const converted = staticValueToPropValue(entry)
        if (converted !== undefined) entries[key] = converted
      }
      return Object.keys(entries).length > 0 ? entries : undefined
    }
    // A bare function or an unresolved value carries nothing renderable.
    case 'fn':
    case 'unresolved':
      return undefined
  }
}

/**
 * `tryResolveExpression`'s structured sibling: also accepts an array/object
 * result. Used only for COMPONENT props (see `extractProps`) — an HTML
 * attribute is a string, so a structured value there is meaningless.
 *
 * Returns no `note`-carrying `Resolution` obligation to the caller, and that is
 * intentional: `withResolutionLock` locks a node because a resolved value must
 * never be written back over its binding, and a structured value is not a
 * writeback target in the first place (`setJsxProp` only takes scalars, and the
 * studio save path filters to scalars before it gets there). Locking the node
 * would cost the user the ability to edit the component's `title` next to an
 * `actions` array they were never able to edit anyway.
 */
export function tryResolvePropValue(
  expr: Node,
  evalCtx: PageEvalContext | undefined,
): ParsedPropValue | undefined {
  if (!evalCtx) return undefined
  return staticValueToPropValue(evaluateExpression(expr, evalCtx.scope, evalCtx.options))
}

/**
 * Combines a node's STRUCTURAL lock (inherited/`.map`/ternary/spread/svg —
 * `structuralLocked`/`structuralReason`, exactly what `processElement` always
 * computed before §7) with any §7 resolutions captured while extracting its
 * props/style/text. A resolved value is DERIVED — see `ParsedNode.resolution`'s
 * doc comment for why the node must be locked — so ANY resolution locks the
 * node even if it wasn't already; a node that was ALREADY locked keeps its
 * original (more specific) reason and just gains the `resolution` metadata.
 * With no resolutions at all (the common, evaluator-off case) this returns
 * EXACTLY `{ locked: structuralLocked, lockReason?: structuralReason }` —
 * byte-identical to what every call site built manually before §7.
 */
export function withResolutionLock(
  structuralLocked: boolean,
  structuralReason: string | undefined,
  resolutions: Resolution[],
): { locked: boolean; lockReason?: string; resolution?: NonNullable<ParsedNode['resolution']> } {
  const primary = resolutions[0]
  if (!primary) {
    return { locked: structuralLocked, ...(structuralReason ? { lockReason: structuralReason } : {}) }
  }
  const resolution = { source: shortenSource(primary.source), ...(primary.note ? { note: primary.note } : {}) }
  if (structuralLocked) {
    return { locked: true, ...(structuralReason ? { lockReason: structuralReason } : {}), resolution }
  }
  return { locked: true, lockReason: `value from ${resolution.source}`, resolution }
}
