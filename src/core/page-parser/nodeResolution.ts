/**
 * nodeResolution — §7.6's wiring glue between `staticEval.ts`'s evaluator and
 * `parsePageFile.ts`'s node construction: turns a resolved `StaticValue` into
 * the prop/style/text value plus the `ParsedNode.resolution` metadata
 * `processElement` attaches to a node. Split out of `parsePageFile.ts` purely
 * to stay under the module-size-budget ceiling — this is wiring glue, not new
 * evaluation logic (the evaluator itself lives in `staticEval.ts`).
 */
import type { Node } from 'ts-morph'
import { evaluateExpression, type EvalScope, type StaticEvalOptions, type StaticValue, type ValueOrigin } from './staticEval'
import type { ParsedNode, ParsedPropValue } from './types'

/** The `(scope, options)` pair `parseJsxTree` builds once per page when the caller opts into §7 — see `ParseContext.eval` in `parsePageFile.ts`. */
export interface PageEvalContext {
  scope: EvalScope
  options: StaticEvalOptions
}

/** A resolved non-literal value, tracked alongside `props`/`inlineStyles`/`text` so `processElement` can record `ParsedNode.resolution` — see its doc comment in `./types`. */
export interface Resolution {
  source: string
  note?: string
}

/**
 * `Resolution`, keyed by WHICH value it explains — a prop name, a
 * `style:<property>` inline-style entry (mirrors `codeProps`' own namespace,
 * see `sourceWritability.ts`'s `styleValueKey`), or the literal key `'text'`
 * for the node's captured text.
 *
 * This is the R2 fix (`STUDIO-FIGMA-PARITY-PLAN.md` §9/F2,
 * `docs/audits/2026-08-06/09-refusal-states.md` finding R2): `ParsedNode.resolution`
 * (singular) only ever kept the FIRST resolution recorded on a node, so a node
 * with two code-valued props showed one real source and a generic "set in code"
 * fallback for the other. `ParsedNode.resolvedProps` is the honest per-key
 * record — additive alongside `resolution`, which keeps its existing singular
 * behaviour unchanged (still consulted by `server/ai/mcp/tools/studio/fidelityReport.ts`
 * and the branch-selection/async-server-component "chose one of several"
 * whole-node note, neither of which needed per-prop granularity).
 */
export type ResolutionMap = Record<string, Resolution>

const MAX_RESOLUTION_SOURCE_LENGTH = 80

/**
 * Caps + collapses whitespace in an expression's source text for a
 * `lockReason`/`resolution.source`/`resolution.note` message — a resolved
 * template literal (or a guard condition's own text) can otherwise be
 * arbitrarily long. Exported for `parsePageFile.ts`'s branch-selection
 * labels (`deriveBranchLabel`, `selectJsxBranch`) — same "short original
 * expression text" need, one implementation.
 */
export function shortenSource(text: string): string {
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
): { value: string | number | boolean; note?: string; origin?: ValueOrigin } | undefined {
  if (!evalCtx) return undefined
  const result: StaticValue = evaluateExpression(expr, evalCtx.scope, evalCtx.options)
  if (result.kind !== 'literal' || result.value === null) return undefined
  return { value: result.value, note: result.note, origin: result.origin }
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
    // A bare function, a statically-absent value, or an unresolved one carries
    // nothing renderable. `undefined` lands here for the same reason `null`
    // does above: React renders neither, and a prop the source leaves absent
    // must stay absent so the component falls back to its own default.
    case 'fn':
    case 'undefined':
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
 * intentional: `ParsedNode.resolution` explains a value the user can SEE but
 * cannot write back over its binding, and a structured value is not a writeback
 * target in the first place (`setJsxProp` only takes scalars, and the studio
 * save path filters to scalars before it gets there). Its read-only-ness is
 * already recorded per-prop in `codeProps` by the caller.
 */
export function tryResolvePropValue(
  expr: Node,
  evalCtx: PageEvalContext | undefined,
): ParsedPropValue | undefined {
  if (!evalCtx) return undefined
  return staticValueToPropValue(evaluateExpression(expr, evalCtx.scope, evalCtx.options))
}

/**
 * Attaches the §7 resolutions captured while extracting a node's
 * props/style/text to that node's STRUCTURAL lock (inherited/`.map`/ternary/
 * spread/svg — `structuralLocked`/`structuralReason`, exactly what
 * `processElement` computes from the JSX itself).
 *
 * **The lock is decided by the structure alone.** A resolution records WHERE a
 * value came from and nothing else: `<h1>{c.heading}</h1>` is an ordinary
 * element at a known line and column, so moving, reordering, wrapping or
 * deleting it is a precise, single-target edit — the same call
 * `branchAlternatives` already makes ("the parser is certain of the STRUCTURE
 * here, it only chose which value/branch to show").
 *
 * This used to lock the node for any resolution at all, reasoning that an
 * edited literal must never be written back over `{c.heading}`. That reason is
 * real, but it is a fact about ONE VALUE, and the per-prop truth already lives
 * in `codeProps` — every `Resolution` recorded here has a matching `codeProps`
 * entry pushed by the same reader (`extractProps`/`extractInlineStyles`, and
 * `codeText` for text), and `isPropWritableToSource` is what every edit guard
 * asks. So the lock added nothing to the refusal and instead made 149 of the
 * 276 locked nodes on the real eSIM board (54%) undraggable, each showing a
 * notice whose first clause — "this element can't be moved or deleted from
 * here" — was false for it. `ParsedNode.locked`'s own doc comment already said
 * it is "deliberately NOT a statement about its values"; this makes the code
 * agree with it.
 *
 * `lockReason` is therefore only ever a STRUCTURAL reason. A node with no
 * structural lock carries none, and the panel explains its resolved values from
 * `resolution` + `codeProps` instead (`SourceConstraintNotice`).
 */
export function withResolution(
  structuralLocked: boolean,
  structuralReason: string | undefined,
  resolutions: Resolution[],
): { locked: boolean; lockReason?: string; resolution?: NonNullable<ParsedNode['resolution']> } {
  const primary = resolutions[0]
  const resolution = primary
    ? { source: shortenSource(primary.source), ...(primary.note ? { note: primary.note } : {}) }
    : undefined
  return {
    locked: structuralLocked,
    ...(structuralLocked && structuralReason ? { lockReason: structuralReason } : {}),
    ...(resolution ? { resolution } : {}),
  }
}

/**
 * R2's per-prop counterpart of `withResolution` — shortens every entry's
 * `source` the same way, and returns `undefined` for an empty map so callers
 * can `...(resolvedProps ? { resolvedProps } : {})` exactly like every other
 * optional `ParsedNode` field. Pure formatting, no locking decision: which
 * keys land in the map is entirely up to the caller (`extractProps`/
 * `extractInlineStyles`/`extractSingleText` build the per-key entries;
 * `processElement` merges them keyed by prop name, `style:<prop>`, or `'text'`
 * — see `ParsedNode.resolvedProps`'s own doc comment in `./types`).
 */
export function shortenResolutionMap(resolutions: ResolutionMap): ResolutionMap | undefined {
  const keys = Object.keys(resolutions)
  if (keys.length === 0) return undefined
  const shortened: ResolutionMap = {}
  for (const key of keys) {
    const entry = resolutions[key]!
    shortened[key] = { source: shortenSource(entry.source), ...(entry.note ? { note: entry.note } : {}) }
  }
  return shortened
}
