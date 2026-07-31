/**
 * branchSelection — parser-06/parser-07: which branch of a multi-return
 * component, a JSX ternary, or a JSX `&&` the parser shows by default, and
 * how it labels the one(s) it did not.
 *
 * Split out of `parsePageFile.ts` purely to stay under the module-size-budget
 * ceiling (`src/__tests__/architecture/module-size-budgets.test.ts`) — this is
 * the self-contained "which branch" DECISION, with no dependency on
 * `processElement`/node construction. `collectRootIds`/`walkExpressionForJsx`
 * (which own the actual JSX WALK and need `processElement`/`expandStaticLoop`
 * directly) stay in `parsePageFile.ts` and call into this module.
 *
 * See `docs/features/studio-import.md`'s "One `return` renders" section for
 * the full rationale. Nothing here EVALUATES a runtime condition unless the
 * static evaluator can already read it from source alone (a literal, a
 * module-scope const, or — parser-07 — a binding's own DEFAULT literal value:
 * a `useState(<default>)` initial value or a destructured prop parameter's
 * own `= <default>`, via `evaluateStaticCondition`) — otherwise this is a
 * stated, POSITIONAL heuristic ("prefer the branch that's there"), never a
 * guess at hook state. That keeps the whole module outside the banned Tier D
 * (`docs/features/studio-import.md`'s "Tier D — banned").
 *
 * parser-07 also closed the one branch-selection path that had NO static
 * check at all: `selectJsxBranch`'s `&&` side used to render its right
 * operand unconditionally, unlike its ternary sibling — see that function's
 * doc comment for the fix and `staticEvalCore.ts`'s
 * `resolveConditionDefaultLiteral` for the default-literal boundary (needed
 * for both `useState(false)` AND `useState(initialStep)` where `initialStep`
 * is itself a defaulted parameter — the real eSIM corpus uses the latter).
 */
import { Node, SyntaxKind, type ReturnStatement } from 'ts-morph'
import type { FunctionLike } from './types'
import type { ParseContext } from './jsxAttributeReaders'
import { evaluateStaticCondition } from './staticEval'
import { shortenSource } from './resolutionLock'

// ---------------------------------------------------------------------------
// Shared JSX-detection helpers
// ---------------------------------------------------------------------------

const JSX_ROOT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.JsxElement,
  SyntaxKind.JsxSelfClosingElement,
  SyntaxKind.JsxFragment,
])

/** Whether `node` is JSX or has JSX anywhere inside it (`cond ? <A/> : <B/>`). */
export function containsJsx(node: Node): boolean {
  if (JSX_ROOT_KINDS.has(node.getKind())) return true
  return node.getFirstDescendant((d) => JSX_ROOT_KINDS.has(d.getKind())) !== undefined
}

export function unwrapParens(node: Node): Node {
  let current = node
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression()
  }
  return current
}

// ---------------------------------------------------------------------------
// Which `return` renders
// ---------------------------------------------------------------------------

/** One `return` in a component's body, and whether the parser SELECTED it. */
export interface ReturnedJsx {
  expr: Node
  /**
   * True for the ONE branch `getReturnedJsxRoots` selected to actually render
   * — always true for a single-return component; exactly one `true` among
   * several JSX-bearing returns otherwise. Only a `chosen` root is walked
   * into real nodes by `parseJsxTree` — see that function's doc comment.
   */
  chosen: boolean
  /**
   * A human label for a NOT-chosen branch, derived from its nearest guard
   * `if` condition (`"loading"`, `"!items.length"`) or a positional fallback
   * (`"branch 2"`) when none could be read. `undefined` when `chosen` is
   * true, or when there is only one JSX-bearing return.
   */
  label?: string
}

/**
 * Every JSX-producing `return` in a component's body, in source order, with
 * exactly ONE marked `chosen: true` when there is more than one.
 *
 * For a concise arrow body (`() => (<div/>)`) that is the body itself. For a
 * block body it is EVERY `return` statement belonging directly to this function
 * — nested function/arrow scopes (event handlers, `.map` callbacks) are not
 * descended into, since their returns belong to a different component.
 *
 * THE RULE: the LAST JSX-bearing return is chosen. Guard clauses — loading,
 * empty, error — are overwhelmingly written as early returns; the return that
 * survives every guard is the component's real, "normal" content. This used to
 * render EVERY return, stacked and locked (parser-06's predecessor policy),
 * which put a genuine visual defect on the board: a card with a loading state,
 * an empty state, and a loaded state rendered all three, in a column, on every
 * screen that used it — never what a user actually sees. Picking is still not
 * Tier D: nothing is EVALUATED (no `loading`/`stage` variable is read), only a
 * POSITION in the source is preferred, exactly the same kind of decision
 * `deriveBranchLabel` below makes about which `if` a return sits under.
 *
 * The branches NOT chosen are not silently discarded — `parseJsxTree` records
 * each as a `BranchAlternative` (label + location) on the chosen node, so an
 * editor surface can still point a user at "the loading state" without ever
 * rendering it by default.
 */
export function getReturnedJsxRoots(fn: FunctionLike): ReturnedJsx[] {
  const body = fn.getBody()
  if (!body) return []

  if (!Node.isBlock(body)) {
    return [{ expr: unwrapParens(body), chosen: true }]
  }

  const returns: ReturnStatement[] = []
  body.forEachDescendant((node, traversal) => {
    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      traversal.skip()
      return
    }
    if (Node.isReturnStatement(node)) returns.push(node)
  })

  // Only JSX-BEARING returns count towards "more than one". `if (!data) return
  // null` is the most common early return there is, and it contributes no nodes
  // — letting it mark the component's real tree conditional would lock an entire
  // editable screen for a guard clause.
  const jsxReturns: { statement: ReturnStatement; expr: Node }[] = []
  for (const statement of returns) {
    const expr = statement.getExpression()
    if (!expr) continue
    const unwrapped = unwrapParens(expr)
    if (containsJsx(unwrapped)) jsxReturns.push({ statement, expr: unwrapped })
  }

  if (jsxReturns.length <= 1) {
    return jsxReturns.map(({ expr }) => ({ expr, chosen: true }))
  }

  const chosenIndex = jsxReturns.length - 1
  return jsxReturns.map(({ statement, expr }, index) =>
    index === chosenIndex
      ? { expr, chosen: true }
      : { expr, chosen: false, label: deriveBranchLabel(statement, index) },
  )
}

/**
 * Best-effort human label for a `return` that lost the selection above:
 * climbs from the `return` statement to the nearest enclosing `if` it sits
 * directly inside (through the `{ }` block, if any) and uses that `if`'s own
 * condition text — `if (loading) return <Spinner/>` labels "loading",
 * `if (!items.length) return <Empty/>` labels "!items.length". Falls back to
 * a positional name when no such `if` is found (e.g. a `switch` case), which
 * is rare enough not to warrant walking every control-flow construct.
 */
function deriveBranchLabel(returnStatement: ReturnStatement, index: number): string {
  let current: Node = returnStatement
  let parent = current.getParent()
  // Bounded, not recursive-to-the-root: a component body is never deep enough
  // to need more than a handful of hops, and this must never hang.
  for (let hop = 0; parent && hop < 40; hop += 1) {
    if (Node.isIfStatement(parent)) {
      if (parent.getThenStatement() === current) return shortenSource(parent.getExpression().getText())
      if (parent.getElseStatement() === current) return `else of ${shortenSource(parent.getExpression().getText())}`
    }
    current = parent
    parent = parent.getParent()
  }
  return `branch ${index + 1}`
}

// ---------------------------------------------------------------------------
// Which side of a ternary / `&&` renders
// ---------------------------------------------------------------------------

export interface BranchSelection {
  /**
   * The side of the conditional to actually walk into. `undefined` only for
   * `&&` whose condition (parser-07) resolves STATICALLY false — nothing
   * renders at this position at all, not even locked, because there is
   * nothing here for the source to have placed.
   */
  chosen: Node | undefined
  /**
   * The side NOT taken, when it carries JSX worth pointing at. For a
   * ternary, the untaken branch's own JSX. For `&&` (parser-07): the SAME
   * right-hand JSX `chosen` points at, labelled as the hidden state — `&&`
   * has no separate "other branch" node, only a shown/hidden toggle on the
   * one JSX that exists, so pointing the alternative at itself is the
   * honest answer, not an approximation. Omitted when the condition is
   * statically known (nothing to switch to) or, for a ternary, when the
   * untaken side has no JSX in it.
   */
  alternative?: Node
  /** Short label for `alternative`, becomes `BranchAlternative.label`. */
  altLabel?: string
  /** Full sentence fragment explaining the choice, becomes `resolution.note`. Unused when `chosen` is `undefined` (no node exists to attach it to). */
  note: string
}

/**
 * Picks one side of a ternary or `&&` met while walking for JSX — the
 * structural, one-level-down sibling of `getReturnedJsxRoots`'s return
 * selection. Returns `undefined` for anything else (a plain value ternary
 * with no JSX in either branch, `||`, a call, …), which sends the caller back
 * to ordinary descent.
 *
 * A ternary prefers the CONSEQUENT — same "the first-written branch is the
 * normal one" rule the multi-return default uses — UNLESS the condition is
 * statically decidable (`evaluateStaticCondition`, Tier A/B only: a literal,
 * a module-scope const, or — parser-07 — a `useState(<literal>)` binding's
 * own initial value, see `staticEvalCore.ts`'s `resolveConditionDefaultLiteral`),
 * in which case that real answer outranks the heuristic and the
 * ACTUALLY-taken side is chosen.
 *
 * `&&` (parser-07) gets the SAME static-condition check the ternary side
 * already had — this used to be the one branch-selection path with no check
 * at all, which is why `{showDataHelp && <Overlay/>}` rendered unconditionally
 * even when `showDataHelp` starts `false`, stacking the overlay on the base
 * screen on every screen that guarded content this way (found measuring the
 * real eSIM board — 3 of 15 screens broken this way). The rule:
 *   - statically FALSE  -> `chosen: undefined`, nothing renders here at all.
 *   - statically TRUE   -> the right side is chosen, no alternative (nothing
 *     to switch to — the parser is certain).
 *   - not statically decidable -> falls back to today's behaviour (render the
 *     right side), but — unlike before parser-07 — records the HIDDEN state
 *     as a `branchAlternatives` entry pointing at the same JSX, so a user can
 *     deliberately toggle to it instead of it being silently assumed away.
 */
export function selectJsxBranch(node: Node, ctx: ParseContext): BranchSelection | undefined {
  if (Node.isConditionalExpression(node)) {
    const whenTrue = node.getWhenTrue()
    const whenFalse = node.getWhenFalse()
    const trueHasJsx = containsJsx(unwrapParens(whenTrue))
    const falseHasJsx = containsJsx(unwrapParens(whenFalse))
    if (!trueHasJsx && !falseHasJsx) return undefined // a plain-value ternary reached here has nothing for this walk to do

    const condText = shortenSource(node.getCondition().getText())
    const known = ctx.eval ? evaluateStaticCondition(node.getCondition(), ctx.eval.scope, ctx.eval.options) : undefined

    if (known === false) {
      return {
        chosen: whenFalse,
        alternative: trueHasJsx ? whenTrue : undefined,
        altLabel: condText,
        note: `${condText} is statically false here — the other branch is not shown`,
      }
    }
    return {
      chosen: whenTrue,
      alternative: falseHasJsx ? whenFalse : undefined,
      altLabel: falseHasJsx ? `not (${condText})` : undefined,
      note:
        known === true
          ? `${condText} is statically true here`
          : `showing the branch taken when ${condText} is truthy — the parser cannot evaluate this condition, so the other branch is not shown`,
    }
  }
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
    const right = unwrapParens(node.getRight())
    if (!containsJsx(right)) return undefined

    const condText = shortenSource(node.getLeft().getText())
    const known = ctx.eval ? evaluateStaticCondition(node.getLeft(), ctx.eval.scope, ctx.eval.options) : undefined

    if (known === false) {
      return {
        chosen: undefined,
        note: `${condText} is statically false here — nothing renders`,
      }
    }
    return {
      chosen: node.getRight(),
      alternative: known === true ? undefined : right,
      altLabel: known === true ? undefined : `not (${condText})`,
      note:
        known === true
          ? `${condText} is statically true here`
          : `rendered only when ${condText} is truthy — the parser cannot evaluate this condition, so the hidden state is recorded as an alternative rather than assumed`,
    }
  }
  return undefined
}

/**
 * An element is on the "dynamic surface" (locked, `DYNAMIC_LOCK_REASON`) when
 * it is rendered from inside a `.map(...)` callback this walk could not
 * expand (a CallExpression — `expandStaticLoop` is always tried first, so
 * this only fires for the ones that fail), or a logical-OR (`||`) JSX
 * expression.
 *
 * A ternary and a logical-AND (`&&`) are deliberately NOT here (parser-06):
 * `collectFromExpression`'s walk SELECTS one side of those instead of
 * rendering both, via `selectJsxBranch` — that is a genuine structural
 * choice, not an unresolvable dynamic surface, so it must not force
 * `DYNAMIC_LOCK_REASON` onto the chosen side. `||` keeps the old, no-choice
 * treatment: unlike `&&` (whose right side IS the one thing that ever
 * renders) and a ternary (two named, equally real sides), `||`'s left operand
 * is ordinarily a value, not JSX, so there is nothing here worth a dedicated
 * selection rule — it stays locked and shown, same as any other unresolvable
 * dynamic content.
 */
export function isLockingExpression(expr: Node): boolean {
  const node = unwrapParens(expr)

  if (Node.isCallExpression(node)) return true
  if (Node.isBinaryExpression(node)) {
    return node.getOperatorToken().getKind() === SyntaxKind.BarBarToken
  }

  return false
}
