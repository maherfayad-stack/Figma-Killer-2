/**
 * prototypeNavScan — the AST rules for "this element navigates somewhere".
 *
 * Purely syntactic, one source file at a time, no type checker and no
 * cross-file resolution. That is a deliberate ceiling, not a shortcut: this
 * runs over every page on every board load, and the honest answer to "where
 * does this go" is only ever available when the destination is written as a
 * literal. A target the parser cannot read as a literal string is REFUSED, not
 * guessed — see `prototypeRouteIndex.ts` for why an invented arrow is the one
 * failure this feature cannot afford.
 *
 * Kept separate from `prototypeCodeFlow.ts` (which owns discovery, the route
 * index and the payload) because these are the rules that change when a router
 * library's spelling changes, and that is a different reason to edit.
 *
 * FOUR RULES, IN THE ORDER THEY FIRE
 * ──────────────────────────────────
 *   1. `href="…"` / `to="…"` as a plain string attribute. `<a>`, `<Link>`,
 *      `<NavLink>`, and every design-system button that forwards one.
 *   2. A navigation CALL anywhere inside a non-string attribute expression:
 *      `onClick={() => navigate('/details')}`,
 *      `toolbar={{ onBack: () => router.push('/home') }}`. The nesting is not
 *      enumerated — the whole attribute expression is walked — because a
 *      handler's depth inside an object prop is not a fact about navigation.
 *   3. `onClick={goToDetails}`, resolved ONE hop to a same-file
 *      `const goToDetails = () => …` / `function goToDetails() {…}` and walked
 *      there. One hop, never a chain: two hops is where a cycle becomes
 *      possible and where the claim stops being obvious from reading the JSX.
 *   4. `window.location.href = '/details'` — an assignment, not a call, so it
 *      needs its own rule.
 */
import { Node, SyntaxKind } from 'ts-morph'
import type { Expression, JsxAttributeLike, JsxOpeningLikeElement, SourceFile } from 'ts-morph'
import type { CodeFlowVia } from '@core/studio-prototype'

/** One navigation fact, before its target has been resolved to a page. */
export interface NavCandidate {
  /** `relFile:line:col` of the element's tag name — the parser's own id grammar. */
  sourceNodeId: string
  /** The raw string the source navigates to, exactly as written. */
  target: string
  via: CodeFlowVia
  /** The source text this was read out of, for the connector's tooltip. */
  evidence: string
}

/** Attributes whose plain string value IS a destination. */
const LINK_TARGET_ATTRIBUTES: ReadonlyMap<string, CodeFlowVia> = new Map([
  ['href', 'href'],
  ['to', 'to'],
])

/**
 * Bare-identifier navigation calls. Every one of these is a hook return value
 * or a module import in the libraries React projects actually use:
 * `const navigate = useNavigate()` (React Router), `redirect()` (Next),
 * `push()` destructured off `useRouter()`.
 */
const NAV_FUNCTIONS: ReadonlySet<string> = new Set(['navigate', 'redirect', 'push', 'replace'])

/**
 * Receivers whose `.push/.replace/.navigate/.assign` is a navigation.
 *
 * Matched on the receiver's LAST identifier (`window.location` -> `location`),
 * so `router`, `history`, `navigation` and `location` are recognised however
 * they were reached. A local variable that happens to be called `router` and
 * is not one would produce a wrong arrow — accepted, because the alternative is
 * a type checker on the hot load path, and a variable named `router` whose
 * `.push('/details')` does not navigate is not a shape that occurs.
 */
const NAV_RECEIVERS: ReadonlySet<string> = new Set(['router', 'history', 'navigation', 'location'])

/** Methods on one of those receivers that move the user. `goBack`/`back` take no target and are out of scope for v1. */
const NAV_METHODS: ReadonlySet<string> = new Set(['push', 'replace', 'navigate', 'assign'])

/** How much of a source expression is quoted as evidence before it stops being readable in a tooltip. */
const EVIDENCE_MAX = 120

function evidenceOf(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > EVIDENCE_MAX ? `${collapsed.slice(0, EVIDENCE_MAX - 1)}…` : collapsed
}

/**
 * The literal string an expression is, or `null`.
 *
 * A template literal with no substitutions is a literal string written with the
 * other quote character. One WITH substitutions is not: `` `/user/${id}` ``
 * names a different route on every render, and there is no single frame the
 * arrow could point at.
 */
function literalString(expression: Expression | undefined): string | null {
  if (!expression) return null
  if (Node.isStringLiteral(expression)) return expression.getLiteralValue()
  if (Node.isNoSubstitutionTemplateLiteral(expression)) return expression.getLiteralValue()
  return null
}

/** The last identifier of a receiver chain — `window.location` -> `location`, `router` -> `router`. */
function receiverName(expression: Expression): string | null {
  if (Node.isIdentifier(expression)) return expression.getText()
  if (Node.isPropertyAccessExpression(expression)) return expression.getNameNode().getText()
  return null
}

/** The destination a single call expression navigates to, or `null`. */
function callTarget(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null
  const callee = call.getExpression()
  const first = call.getArguments()[0]
  const argument = first && Node.isExpression(first) ? first : undefined

  if (Node.isIdentifier(callee)) {
    return NAV_FUNCTIONS.has(callee.getText()) ? literalString(argument) : null
  }
  if (Node.isPropertyAccessExpression(callee)) {
    if (!NAV_METHODS.has(callee.getNameNode().getText())) return null
    const receiver = receiverName(callee.getExpression())
    return receiver !== null && NAV_RECEIVERS.has(receiver.toLowerCase()) ? literalString(argument) : null
  }
  return null
}

/** `location.href = '/details'` / `window.location.href = '/details'`. */
function assignmentTarget(node: Node): string | null {
  if (!Node.isBinaryExpression(node)) return null
  if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return null
  const left = node.getLeft()
  if (!Node.isPropertyAccessExpression(left)) return null
  if (left.getNameNode().getText() !== 'href') return null
  const receiver = receiverName(left.getExpression())
  if (receiver === null || receiver.toLowerCase() !== 'location') return null
  return literalString(node.getRight())
}

/**
 * Every navigation written inside `expression`, at any nesting depth.
 *
 * `seen` is threaded through so rule 3's one-hop identifier resolution cannot
 * walk the same declaration twice — a `const a = () => b()` /
 * `const b = () => a()` pair is legal source and would otherwise not terminate.
 */
function collectNavigations(
  expression: Node,
  sourceFile: SourceFile,
  hop: number,
  seen: Set<string>,
  out: { target: string; evidence: string }[],
): void {
  for (const descendant of [expression, ...expression.getDescendants()]) {
    const called = callTarget(descendant)
    if (called !== null) {
      out.push({ target: called, evidence: evidenceOf(descendant.getText()) })
      continue
    }
    const assigned = assignmentTarget(descendant)
    if (assigned !== null) {
      out.push({ target: assigned, evidence: evidenceOf(descendant.getText()) })
      continue
    }
    // Rule 3 — a bare identifier handler. Only ever followed from the JSX
    // attribute itself (`hop === 0`); a handler that calls another named
    // function is a chain this deliberately does not walk.
    if (hop === 0 && Node.isIdentifier(descendant) && !seen.has(descendant.getText())) {
      const name = descendant.getText()
      seen.add(name)
      const declaration = findLocalFunctionBody(sourceFile, name)
      if (declaration) collectNavigations(declaration, sourceFile, hop + 1, seen, out)
    }
  }
}

/**
 * The body of a same-file `const name = () => …` or `function name() {…}`.
 *
 * Same-file only, on purpose: an imported handler is a different file's
 * behaviour, and following it would make one page's flow map depend on a module
 * graph this scan does not build.
 */
function findLocalFunctionBody(sourceFile: SourceFile, name: string): Node | undefined {
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (declaration.getName() !== name) continue
    const initializer = declaration.getInitializer()
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer
    }
  }
  return sourceFile.getFunction(name)
}

/** Rule 1 — a `href`/`to` attribute whose value is a plain string. */
function linkAttributeTarget(attribute: JsxAttributeLike): { target: string; via: CodeFlowVia; evidence: string } | null {
  if (!Node.isJsxAttribute(attribute)) return null
  const via = LINK_TARGET_ATTRIBUTES.get(attribute.getNameNode().getText())
  if (!via) return null

  const initializer = attribute.getInitializer()
  const value = Node.isJsxExpression(initializer)
    ? literalString(initializer.getExpression())
    : literalString(initializer as Expression | undefined)
  if (value === null) return null
  return { target: value, via, evidence: evidenceOf(attribute.getText()) }
}

/** The `relFile:line:col` id the page parser would mint for this element. */
function elementNodeId(element: JsxOpeningLikeElement, sourceFile: SourceFile, relFile: string): string {
  const { line, column } = sourceFile.getLineAndColumnAtPos(element.getTagNameNode().getStart())
  return `${relFile}:${line}:${column}`
}

/**
 * Every navigation candidate written in one page file, in source order.
 *
 * Deliberately scans the WHOLE file rather than only the component's returned
 * JSX: a page file routinely defines small local components above its default
 * export, and a `<Link>` inside one of them is still navigation this page
 * performs. Their node ids are minted the same way and belong to the same page.
 */
export function scanNavCandidates(sourceFile: SourceFile, relFile: string): NavCandidate[] {
  const candidates: NavCandidate[] = []
  const elements: JsxOpeningLikeElement[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]

  for (const element of elements) {
    const sourceNodeId = elementNodeId(element, sourceFile, relFile)

    for (const attribute of element.getAttributes()) {
      const link = linkAttributeTarget(attribute)
      if (link) {
        candidates.push({ sourceNodeId, ...link })
        continue
      }
      if (!Node.isJsxAttribute(attribute)) continue
      const initializer = attribute.getInitializer()
      if (!Node.isJsxExpression(initializer)) continue
      const expression = initializer.getExpression()
      if (!expression) continue

      const navigations: { target: string; evidence: string }[] = []
      collectNavigations(expression, sourceFile, 0, new Set(), navigations)
      for (const navigation of navigations) {
        candidates.push({ sourceNodeId, target: navigation.target, via: 'call', evidence: navigation.evidence })
      }
    }
  }

  return candidates
}
