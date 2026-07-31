/**
 * staticEvalValues — operations on ALREADY-RESOLVED `StaticValue`s, plus the
 * two constructors every tier builds one with.
 *
 * A pure leaf, like `./staticEvalTypes` and `./staticEvalOperators`: it imports
 * ts-morph and the value types, and nothing else in this package imports back
 * into it. That is what lets `staticEvalCore` (the walker), `staticEvalCalls`
 * (Tier B/C) and `staticEvalOperators` (arithmetic/logical) all share ONE
 * `unresolved`/`withNote`/`pluck` without a cycle — `staticEvalOperators` used
 * to carry its own private copy of `unresolved` for exactly that reason.
 *
 * Nothing here walks the AST or recurses. `pluck` is handed a value the walker
 * already produced; `originOf` is handed a literal token and a root. Keep it
 * that way — anything that needs to evaluate a sub-expression belongs in
 * `./staticEvalCore`.
 */
import { Node } from 'ts-morph'
import * as path from 'node:path'
import type { StaticValue, ValueOrigin } from './staticEvalTypes'

export function unresolved(reason: string, partial?: string): StaticValue {
  return partial !== undefined ? { kind: 'unresolved', reason, partial } : { kind: 'unresolved', reason }
}

export function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) current = current.getExpression()
  return current
}

/**
 * `{ origin }` for a literal token, or `{}` when it cannot be addressed — no
 * configured workspace root, or a file outside it (a `node_modules` dictionary
 * is not the user's to rewrite).
 */
export function originOf(literal: Node, workspaceRoot: string | undefined): { origin?: ValueOrigin } {
  if (!workspaceRoot) return {}
  const sourceFile = literal.getSourceFile()
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(sourceFile.getFilePath()))
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return {}
  const { line, column } = sourceFile.getLineAndColumnAtPos(literal.getStart())
  return { origin: { rel: rel.split(path.sep).join('/'), line, col: column } }
}

/** Propagates a Tier B.4 branch-pick note onto a value, without ever overwriting a MORE specific (deeper) note already attached. */
export function withNote(value: StaticValue, note: string | undefined): StaticValue {
  if (!note || value.kind === 'unresolved' || value.kind === 'fn' || value.kind === 'undefined' || value.note) return value
  return { ...value, note }
}

/**
 * `value[key]`, with the `undefined` cases answered rather than surrendered.
 *
 * A key missing from a `complete` object, or an index past the end of a
 * `complete` array, is not a resolution FAILURE — the source states there is
 * nothing there. Returning `unresolved` for those threw away a Tier A answer
 * every conditional downstream then had to guess at; see `StaticValue`'s
 * `'undefined'` variant for the concrete row-of-a-`.map` defect that caused.
 * An INCOMPLETE object/array still declines, because a spread or a computed key
 * really can put something at `key` that this evaluator never saw.
 */
export function pluck(value: StaticValue, key: string): StaticValue {
  if (value.kind === 'object') {
    const found = value.entries.get(key)
    if (found !== undefined) return withNote(found, value.note)
    return value.complete ? { kind: 'undefined' } : unresolved(`property "${key}" not found`)
  }
  if (value.kind === 'array') {
    // `.length` is the one array member a design tool actually meets, and it is
    // what decides `{i < items.length - 1 && <Separator/>}` — the standard way
    // a list omits its trailing rule — once the loop index is bound per row.
    if (key === 'length') {
      return value.complete
        ? { kind: 'literal', value: value.items.length }
        : unresolved('array length is not statically known (spread element)')
    }
    const idx = Number(key)
    if (Number.isInteger(idx) && idx >= 0 && idx < value.items.length) return withNote(value.items[idx]!, value.note)
    if (value.complete && Number.isInteger(idx) && idx >= 0) return { kind: 'undefined' }
    return unresolved(`index "${key}" not found on array`)
  }
  if (value.kind === 'unresolved') return value
  if (value.kind === 'undefined') return unresolved(`cannot read property "${key}" of undefined`)
  return unresolved(`cannot read property "${key}" of a ${value.kind} value`)
}

/**
 * `Math`'s numeric constants. Its FUNCTIONS are callable through
 * `./staticEvalCalls`'s own whitelist, but a constant is a property access, so
 * `2 * Math.PI * RADIUS` — the circumference every progress ring in every
 * codebase is drawn from — resolved to nothing without this.
 */
const MATH_CONSTANTS: ReadonlyMap<string, number> = new Map(
  (['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2'] as const)
    .map((key) => [key, Math[key]]),
)

/** The numeric value of `Math.<name>`, or `undefined` when `name` is not one of its constants. */
export function mathConstant(name: string): number | undefined {
  return MATH_CONSTANTS.get(name)
}

/** A value a comparison operator can be applied to: a scalar, or a statically-known `undefined` (`addOn.image !== undefined`). */
export type ComparableValue = Extract<StaticValue, { kind: 'literal' } | { kind: 'undefined' }>

export function isComparable(value: StaticValue): value is ComparableValue {
  return value.kind === 'literal' || value.kind === 'undefined'
}

export function comparableValue(value: ComparableValue): unknown {
  return value.kind === 'literal' ? value.value : undefined
}
