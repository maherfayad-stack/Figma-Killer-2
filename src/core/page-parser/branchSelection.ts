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
 * own `= <default>`, via `./defaultLiteralBindings`) — otherwise this is a
 * stated, POSITIONAL heuristic ("prefer the branch that's there"), never a
 * guess at hook state. That keeps the whole module outside the banned Tier D
 * (`docs/features/studio-import.md`'s "Tier D — banned").
 *
 * parser-07 closed the two branch-selection paths that had no static check at
 * all. `&&` used to render its right operand unconditionally, unlike its
 * ternary sibling, so every `{isOpen && <Sheet/>}` painted on top of the base
 * screen. `||` was locked-and-shown and `??` was not recognised at all — each
 * turns on a DIFFERENT notion of "present" (truthiness vs nullishness), so
 * each has its own function below saying why it resolves the way it does.
 */
import { Node, SyntaxKind, type BinaryExpression, type ConditionalExpression, type ReturnStatement } from 'ts-morph'
import type { FunctionLike } from './types'
import type { ParseContext } from './jsxAttributeReaders'
import { evaluateStaticTruthiness, evaluateStaticNullish } from './staticEval'
import { shortenSource } from './nodeResolution'

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
   * The side of the conditional to actually walk into. `undefined` when the
   * condition resolves statically to the side that carries no JSX — a false
   * `&&`, or a `||`/`??` whose left operand wins and is a plain value.
   * Nothing renders at this position at all, not even locked, because there
   * is nothing here for the source to have placed.
   */
  chosen: Node | undefined
  /**
   * The side NOT taken, when it carries JSX worth pointing at. For a ternary,
   * the untaken branch's own JSX. For `&&`/`||`/`??` whose other operand is a
   * plain value: the SAME JSX `chosen` points at, labelled as the hidden
   * state — those forms have no separate "other branch" node, only a
   * shown/hidden toggle on the one JSX that exists, so pointing the
   * alternative at itself is the honest answer, not an approximation.
   * Omitted when the condition is statically known (nothing to switch to)
   * or, for a ternary, when the untaken side has no JSX in it.
   */
  alternative?: Node
  /** Short label for `alternative`, becomes `BranchAlternative.label`. */
  altLabel?: string
  /** Full sentence fragment explaining the choice, becomes `resolution.note`. Unused when `chosen` is `undefined` (no node exists to attach it to). */
  note: string
}

/**
 * Picks one side of a JSX conditional met while walking for JSX — the
 * structural, one-level-down sibling of `getReturnedJsxRoots`'s return
 * selection. Covers all four shapes a React screen guards content with:
 * `cond ? <A/> : <B/>`, `cond && <A/>`, `value || <Fallback/>`, and
 * `value ?? <Fallback/>`. Returns `undefined` for anything else (a plain-value
 * conditional with no JSX in it, a call, …), which sends the caller back to
 * ordinary descent.
 *
 * The shared rule across all four: a condition the static evaluator can
 * actually decide (Tier A/B only — a literal, a module-scope const, or
 * parser-07's default-literal read in `./defaultLiteralBindings`) is a REAL
 * answer and always outranks the positional heuristic. When it cannot decide,
 * each form falls back to a stated preference and records the side it did not
 * take as a `branchAlternatives` entry, so the hidden state stays reachable
 * from the editor instead of being silently assumed away. Nothing is ever
 * executed, so none of this is the banned Tier D.
 *
 * The four forms differ in what "decided" MEANS, and each one is handled by
 * its own function below because getting that wrong renders the wrong screen:
 * `&&`/`||`/a ternary all turn on TRUTHINESS, `??` turns on NULLISHNESS.
 */
export function selectJsxBranch(node: Node, ctx: ParseContext): BranchSelection | undefined {
  if (Node.isConditionalExpression(node)) return selectTernaryBranch(node, ctx)
  if (!Node.isBinaryExpression(node)) return undefined
  const operator = node.getOperatorToken().getKind()
  if (operator === SyntaxKind.AmpersandAmpersandToken) return selectAndBranch(node, ctx)
  if (operator === SyntaxKind.BarBarToken) return selectFallbackBranch(node, ctx, 'or')
  if (operator === SyntaxKind.QuestionQuestionToken) return selectFallbackBranch(node, ctx, 'nullish')
  return undefined
}

/**
 * `cond ? <A/> : <B/>` — two named, equally real sides.
 *
 * Prefers the CONSEQUENT when the condition can't be decided: the same "the
 * first-written branch is the normal one" rule the multi-return default uses.
 */
function selectTernaryBranch(node: ConditionalExpression, ctx: ParseContext): BranchSelection | undefined {
  const whenTrue = node.getWhenTrue()
  const whenFalse = node.getWhenFalse()
  const trueHasJsx = containsJsx(unwrapParens(whenTrue))
  const falseHasJsx = containsJsx(unwrapParens(whenFalse))
  if (!trueHasJsx && !falseHasJsx) return undefined // a plain-value ternary reached here has nothing for this walk to do

  const condText = shortenSource(node.getCondition().getText())
  const known = ctx.eval ? evaluateStaticTruthiness(node.getCondition(), ctx.eval.scope, ctx.eval.options) : undefined

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

/**
 * `cond && <A/>` — one piece of JSX that is either shown or absent. There is
 * no second branch: a falsy `cond` renders nothing at all.
 *
 * This used to be the one branch-selection path with NO static check, which is
 * why `{showDataHelp && <Overlay/>}` rendered unconditionally even when
 * `showDataHelp` starts `false`, stacking the overlay on the base screen on
 * every screen that guarded content this way (3 of 15 screens on the real eSIM
 * board). The rule:
 *   - statically FALSE  -> `chosen: undefined`, nothing renders here at all.
 *   - statically TRUE   -> the right side is chosen, no alternative (nothing
 *     to switch to — the parser is certain).
 *   - not decidable -> render the right side (the JSX that is actually there),
 *     recording the HIDDEN state as an alternative pointing at that same JSX
 *     — `&&` has no separate "other branch" node, only a shown/hidden toggle
 *     on the one piece of JSX that exists, so pointing the alternative at
 *     itself is the honest answer, not an approximation.
 */
function selectAndBranch(node: BinaryExpression, ctx: ParseContext): BranchSelection | undefined {
  const right = unwrapParens(node.getRight())
  if (!containsJsx(right)) return undefined

  const condText = shortenSource(node.getLeft().getText())
  const known = ctx.eval ? evaluateStaticTruthiness(node.getLeft(), ctx.eval.scope, ctx.eval.options) : undefined

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

/**
 * `value || <Fallback/>` and `value ?? <Fallback/>` — the two FALLBACK forms.
 * Both render their left operand when it is "present" and the right one only
 * when it is not; they are one function because that four-way outcome is
 * identical, and they take a `kind` because **what counts as present is not**:
 *
 *   - `||` falls through on FALSINESS. `{count || <Empty/>}` with `count === 0`
 *     renders `<Empty/>`, so `evaluateStaticTruthiness` (truthiness) is the
 *     right question and `known === true` means the fallback never appears.
 *   - `??` falls through only on NULLISHNESS. That same `{count ?? <Empty/>}`
 *     with `count === 0` renders `0`, NOT the fallback. Deciding it with a
 *     truthiness test would wrongly show the fallback for every
 *     falsy-but-present value (`0`, `''`, `false`), so it asks
 *     `evaluateStaticNullish` instead.
 *
 * Given that, `takesLeft` reads the same for both: the left operand is what
 * renders.
 *   - `takesLeft === true`  -> the fallback never appears. If the left operand
 *     is itself JSX it is chosen; otherwise nothing is chosen here at all,
 *     because a plain VALUE renders as this expression's text, not as a node
 *     (the same reason a statically-false `&&` chooses nothing).
 *   - `takesLeft === false` -> the fallback renders, and the parser is certain,
 *     so no alternative is recorded.
 *   - not decidable -> prefer a JSX left operand (the ternary's
 *     "first-written branch" rule, since `a || b` is `a ? a : b`); when the
 *     left is a plain value — overwhelmingly the common shape — the fallback
 *     is the only JSX present, so render it and record the left-hand state as
 *     the alternative.
 *
 * Before this, `||` was treated as an unresolvable dynamic surface: the
 * fallback rendered LOCKED, with no note and no alternative, and `??` was not
 * recognised at all — it fell through to ordinary descent, which walks BOTH
 * operands and stacks them whenever the left side is also JSX.
 */
function selectFallbackBranch(node: BinaryExpression, ctx: ParseContext, kind: 'or' | 'nullish'): BranchSelection | undefined {
  const left = node.getLeft()
  const right = unwrapParens(node.getRight())
  if (!containsJsx(right)) return undefined
  const leftHasJsx = containsJsx(unwrapParens(left))

  const condText = shortenSource(left.getText())
  const present = kind === 'or' ? 'truthy' : 'not null'
  let takesLeft: boolean | undefined
  if (ctx.eval) {
    const decided =
      kind === 'or'
        ? evaluateStaticTruthiness(left, ctx.eval.scope, ctx.eval.options)
        : evaluateStaticNullish(left, ctx.eval.scope, ctx.eval.options)
    // `evaluateStaticNullish` answers the INVERSE question ("is it absent?"),
    // so its `true` is the case where the left side does NOT render.
    takesLeft = decided === undefined ? undefined : kind === 'or' ? decided : !decided
  }

  if (takesLeft === true) {
    return {
      chosen: leftHasJsx ? left : undefined,
      note: `${condText} is statically ${present} here — the fallback is not shown`,
    }
  }
  if (takesLeft === false) {
    return {
      chosen: node.getRight(),
      note: `${condText} is statically ${kind === 'or' ? 'falsy' : 'null'} here — the fallback is what renders`,
    }
  }
  return {
    chosen: leftHasJsx ? left : node.getRight(),
    // Either way the alternative points at the right operand: when the left is
    // JSX that is the genuinely untaken branch, and when it is a plain value
    // the fallback is the only JSX here, so — as with `&&` — the shown/hidden
    // toggle hangs off the one node that exists.
    alternative: right,
    altLabel: leftHasJsx ? `not (${condText})` : condText,
    note: leftHasJsx
      ? `showing the branch taken when ${condText} is ${present} — the parser cannot evaluate this, so the fallback is not shown`
      : `the fallback, rendered when ${condText} is not ${present} — the parser cannot evaluate this, so the ${condText} state is recorded as an alternative rather than assumed`,
  }
}

/**
 * An element is on the "dynamic surface" (locked, `DYNAMIC_LOCK_REASON`) when
 * it is rendered from inside a `.map(...)` callback this walk could not expand
 * — a CallExpression, and only the ones that fail, since `expandStaticLoop` is
 * always tried first.
 *
 * No conditional is here any more. `collectFromExpression`'s walk SELECTS one
 * side of a ternary, `&&`, `||` and `??` instead of rendering both, via
 * `selectJsxBranch` — a genuine structural choice, not an unresolvable dynamic
 * surface, so it must not force `DYNAMIC_LOCK_REASON` onto the chosen side.
 * `||` was the last holdout (parser-06 left it locked because its left operand
 * is ordinarily a value rather than JSX); parser-07 gave it a real selection
 * rule, which makes the fallback an ordinary editable node with a recorded
 * alternative rather than a locked one with no explanation.
 */
export function isLockingExpression(expr: Node): boolean {
  return Node.isCallExpression(unwrapParens(expr))
}
