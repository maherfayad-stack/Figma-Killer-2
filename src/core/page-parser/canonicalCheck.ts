/**
 * canonicalCheck — WS-13's validator: given a `ParsedPage`, reports which of
 * the ten canonical-JSX rules (`docs/reference/canonical-jsx.md` §2) a file's
 * nodes trip, with `file:line:col`.
 *
 * **Two tiers, not a flat finding list.** Three of the ten rules
 * (`literal-props`, `static-class-name`, `no-wrapper-elements`) fire on
 * shapes the rule text itself PERMITS — a module-scope `const` prop, a
 * `styles.x` className, an admitted heuristic's false positive — because the
 * underlying parser signal cannot tell "permitted" from "forbidden" apart. A
 * flat severity made those three indistinguishable from a genuine
 * `no-spread-props` violation, which is false to WS-13 §3's own premise ("a
 * canonical file is almost exactly a file with zero findings" — it is zero
 * `'violation'` findings, not zero findings) and made the validator useless
 * to the very things that need to self-check against it (step 4's
 * scaffolder, WS-12's agent). See `CanonicalTier`'s own doc comment for the
 * exact rule, and `summarizeCanonicalFindings` for the one signal a caller
 * should act on.
 *
 * **Reports, never blocks (D5).** Nothing here rejects a write, throws, or
 * mutates anything — it is a read-only view over signals `parsePageFile.ts`
 * already produces, plus two genuinely new structural checks
 * (`single-styling-mechanism`, `no-wrapper-elements`) that WS-13 §3 called out
 * as needing one alongside a third, `single-return`, that turned out NOT to be
 * new on inspection — it reuses `branchAlternatives`, a signal parser-06/07
 * already produce for `BRANCH_AUTO_SELECTED`. Running this against an
 * arbitrary IMPORTED repo is expected to produce a wall of findings that mean
 * nothing — that repo was never trying to be canonical. It is meant for files
 * Studio (or its agent) authored, on demand.
 *
 * Mirrors `server/ai/mcp/tools/studio/fidelityCodes.ts`'s registry pattern —
 * a rule, its message, and its documentation entry cannot drift apart — but
 * is a SEPARATE vocabulary from `PARSER_FIDELITY_CODES`. The two answer
 * different questions at different granularity (a fidelity code answers "did
 * this resolve", a canonical rule answers "was this authored in the subset
 * the tool round-trips losslessly") and conflating their ids would make ONE
 * fidelity signal (e.g. `CODE_VALUED_PROP`) impossible to reuse across TWO
 * canonical rules (`literal-props` for an ordinary prop, `static-class-name`
 * for `className` specifically) without inventing a fake distinction in the
 * fidelity registry itself.
 *
 * `canonicalCheck.test.ts` gates doc <-> rule parity the same way
 * `fidelityCodes.test.ts` gates fidelity-code <-> doc parity: every id in
 * `CANONICAL_JSX_RULES` must appear in `docs/reference/canonical-jsx.md`, and
 * vice versa.
 *
 * A NUMBER of the ten rules turned out, on inspection of the actual signals,
 * to be imprecise in ways worth stating up front rather than silently
 * encoding — see each check's own doc comment for the specific caveat:
 *
 *   - `single-return`'s signal (`branchAlternatives`) is not scoped to a
 *     TOP-LEVEL multi-return; it fires identically for a nested ternary/`&&`/
 *     `||`/`??` one level into the JSX (parser-06/07). The rule's title in
 *     the WS-13 table ("One `return`") undersells what it actually catches.
 *   - `literal-props`/`static-class-name` (both `tier: 'advisory'` for
 *     exactly this reason) cannot distinguish "resolved from a canonical
 *     module-scope `const` identifier" (which the rule text explicitly
 *     allows) from "resolved from hook state or an unresolvable expression"
 *     (which it does not) — `ParsedNode.codeProps` records THAT a value is
 *     code, never WHY. A prop that is a bare reference to a module-scope
 *     `const` therefore still registers here. Documented, not silently
 *     swallowed — see `docs/reference/canonical-jsx.md`.
 *   - `static-class-name` ALSO fires for the canonical `styles.x` CSS-Modules
 *     shape the rule explicitly permits, for the identical reason: a
 *     CSS-Modules-resolved class name genuinely cannot be typed over in the
 *     Properties panel (same "structure vs. values" split as any other
 *     resolved prop), so the finding is accurate, just not disqualifying —
 *     which is exactly what its `'advisory'` tier means.
 *   - A className that fails to resolve AT ALL (a genuinely dynamic
 *     interpolation with no static path) still carries no VALUE — `extractProps`
 *     writes no `className` into `props`, so the canvas renders no class from
 *     it — but it is no longer invisible: `extractProps`' catch-all now names
 *     it in `codeProps` regardless (board-27b), so `static-class-name` DOES
 *     see this shape now, same as every other unresolvable className. Before
 *     that fix this was the one shape neither `props` nor `codeProps` recorded
 *     at all, which meant `isPropWritableToSource` read it as ordinarily
 *     writable and a panel edit would have `setJsxProp` a baked literal
 *     straight over the interpolation — the same destructive-write hole the
 *     fix closed for every other unresolvable prop.
 *   - `static-svg`'s signal (`DYNAMIC_SVG_LOCK_REASON`) is reachable, for a
 *     JSX-authored `<svg>`, ONLY when the serialized markup exceeds
 *     `MAX_MARKUP_LENGTH` (64 KB) — `serializeInlineSvg` omits an
 *     unresolvable piece rather than failing the whole element, so an svg
 *     with one dynamic attribute still serializes (missing that attribute)
 *     rather than locking. The `dangerouslySetInnerHTML`-transform case
 *     (`applyTokens(svg)`) is a THIRD, wholly undetected shape: when its
 *     fallback also fails to resolve, the element is not locked at all and
 *     carries no `svg` prop — see `resolveRawSvgMarkup`.
 */
import { LOOP_ID_SEPARATOR } from '@core/page-tree'
import { DYNAMIC_LOCK_REASON, DYNAMIC_SVG_LOCK_REASON, SPREAD_LOCK_REASON } from './parsePageFile'
import type { ComponentSource } from './componentSources'
import type { NodeLoc, ParsedNode, ParsedPage } from './types'

export type CanonicalRuleId =
  | 'single-return'
  | 'literal-props'
  | 'literal-text'
  | 'const-array-map'
  | 'no-spread-props'
  | 'static-class-name'
  | 'single-styling-mechanism'
  | 'static-svg'
  | 'direct-component-imports'
  | 'no-wrapper-elements'

/**
 * `'violation'` — the underlying signal PROVES the rule is broken; every
 * shape it fires on is genuinely non-canonical. Zero `'violation'` findings
 * on a file means it is canonical.
 *
 * `'advisory'` — the underlying signal cannot tell a PERMITTED shape from a
 * forbidden one (`literal-props`'s module-scope const, `static-class-name`'s
 * `styles.x`), or the check is an admitted heuristic that accepts false
 * positives (`no-wrapper-elements`). Worth surfacing — a caller deciding
 * whether to restyle via `styles.x` or a literal wants to know either way —
 * but never disqualifying. Do NOT suppress an advisory finding to make it
 * look like zero: the detection is accurate, only its severity is not
 * "broken".
 */
export type CanonicalTier = 'violation' | 'advisory'

export interface CanonicalRuleDef {
  id: CanonicalRuleId
  title: string
  /** The rule, stated precisely — matches `docs/reference/canonical-jsx.md`'s own wording for this rule. */
  description: string
  /** "Because, without it: ..." — the documented limitation this rule exists to stay clear of. */
  because: string
  tier: CanonicalTier
}

/**
 * WS-13 §2's ten rules, in table order. Titles/descriptions are the doc's own
 * wording — `canonicalCheck.test.ts` checks this array against
 * `docs/reference/canonical-jsx.md` verbatim, so editing one without the
 * other fails the gate (tier included).
 */
export const CANONICAL_JSX_RULES: readonly CanonicalRuleDef[] = [
  {
    id: 'single-return',
    title: 'One return',
    description: 'No top-level conditional rendering, no multi-stage screens.',
    because: 'BRANCH_AUTO_SELECTED — the parser picks one branch and can pick wrong.',
    tier: 'violation',
  },
  {
    id: 'literal-props',
    title: 'Literal or const props',
    description: 'Props are literals or module-scope consts.',
    because:
      'Tier A resolves those. A prop from hook state or an unresolvable expression becomes CODE_VALUED_PROP — read-only.',
    tier: 'advisory',
  },
  {
    id: 'literal-text',
    title: 'Literal text',
    description: 'Text is a literal string in the JSX.',
    because:
      'textOrigin writeback needs a literal to target. Text produced by a runtime expression cannot be edited on canvas.',
    tier: 'violation',
  },
  {
    id: 'const-array-map',
    title: 'Bounded .map',
    description: '.map only over a module-scope const array.',
    because:
      'Bounded loop expansion handles those. A .map over props/state/fetch collapses to one opaque locked node.',
    tier: 'violation',
  },
  {
    id: 'no-spread-props',
    title: 'No spread props',
    description: 'No {...spread}.',
    because: 'SPREAD_PROPS_UNRESOLVED — the prop bag is unreadable.',
    tier: 'violation',
  },
  {
    id: 'static-class-name',
    title: 'Static className',
    description: 'className is a static string or styles.x.',
    because: 'A computed interpolation keeps only its static prefix.',
    tier: 'advisory',
  },
  {
    id: 'single-styling-mechanism',
    title: 'One styling mechanism',
    description: 'One authored styling mechanism: plain CSS or CSS Modules.',
    because:
      'Sass/Less/PostCSS/Tailwind need Tier 1 trust promotion; CSS-in-JS is detected but never compiled. This governs the CSS you write — not CSS a package ships.',
    tier: 'violation',
  },
  {
    id: 'static-svg',
    title: 'Static inline SVG',
    description: 'Inline <svg> is static JSX.',
    because: "A dynamic attribute is dropped; SVG built by a transform doesn't resolve at all.",
    tier: 'violation',
  },
  {
    id: 'direct-component-imports',
    title: 'Direct component imports',
    description: 'Components are imported directly — local or from an npm package.',
    because: 'Resolution stays traceable through componentSources.ts.',
    tier: 'violation',
  },
  {
    id: 'no-wrapper-elements',
    title: 'No wrapper elements',
    description: 'No wrapper elements added around content.',
    because: "Trap #1 — breaks %/flex chains and >/+/:nth-child combinators.",
    tier: 'advisory',
  },
]

const RULE_BY_ID = new Map(CANONICAL_JSX_RULES.map((r) => [r.id, r]))

export function canonicalRuleDef(id: CanonicalRuleId): CanonicalRuleDef | undefined {
  return RULE_BY_ID.get(id)
}

export interface CanonicalFinding {
  ruleId: CanonicalRuleId
  /** Copied from the rule's own `tier` at construction time, so a caller never has to re-look it up via `canonicalRuleDef`. */
  tier: CanonicalTier
  nodeId: string
  file: string
  line: number
  col: number
  message: string
}

/** Every `'violation'` means non-canonical; an `'advisory'` is worth reading, never disqualifying. */
export interface CanonicalSummary {
  violations: number
  advisories: number
  /** `violations === 0` — the single signal step 4's scaffolder and WS-12's agent should check, rather than a raw finding count. */
  isCanonical: boolean
}

/** Tallies a `checkCanonicalJsx` result into the one honest signal a caller needs: is this file canonical, and how many findings of each tier does it carry. */
export function summarizeCanonicalFindings(findings: readonly CanonicalFinding[]): CanonicalSummary {
  const violations = findings.filter((f) => f.tier === 'violation').length
  const advisories = findings.length - violations
  return { violations, advisories, isCanonical: violations === 0 }
}

export interface CanonicalCheckInput {
  page: ParsedPage
  /**
   * Raw source text of the page's OWN file (not any inlined component's).
   * Needed only by `single-styling-mechanism`, which scans import specifiers
   * for a Sass/Less/CSS-in-JS mechanism — a project-file-level fact
   * `ParsedNode`s don't carry. Every other rule runs from `page` alone;
   * omitting this one just skips that rule (never throws, never guesses).
   */
  sourceText?: string
  /**
   * From `resolveComponentSources` (`./componentSources`) for the SAME page.
   * Needed only by `direct-component-imports`, to tell "this tag resolved to
   * a real local file or package specifier" from "the parser could not trace
   * it to anything in scope". Omitting this just skips that rule.
   */
  componentSources?: Record<string, ComponentSource>
}

/** Every rule id in `CanonicalRuleId` has a registry entry (`CANONICAL_JSX_RULES` is this module's own exhaustive list), so the `!` here can never actually be `undefined` — it exists to keep `tier` required on `CanonicalFinding` without threading it through every call site. */
function tierOf(ruleId: CanonicalRuleId): CanonicalTier {
  return RULE_BY_ID.get(ruleId)!.tier
}

function finding(ruleId: CanonicalRuleId, node: ParsedNode, message: string): CanonicalFinding {
  return { ruleId, tier: tierOf(ruleId), nodeId: node.id, file: node.loc.file, line: node.loc.line, col: node.loc.col, message }
}

function findingAt(ruleId: CanonicalRuleId, nodeId: string, loc: NodeLoc, message: string): CanonicalFinding {
  return { ruleId, tier: tierOf(ruleId), nodeId, file: loc.file, line: loc.line, col: loc.col, message }
}

/**
 * True when `nodeId` was produced anywhere inside a `.map` expansion — the
 * loop row itself (`…:70:21#0`), or a node INLINED into that row (a
 * composite id whose FIRST segment carries the loop marker:
 * `…:10:5#0~PlanCard.tsx:8:5`). `hasWritableSourceLocation` (`@core/page-tree`)
 * answers a narrower question — "does the id's TAIL alone resolve to a
 * source location" — which is `true` for the inlined case above (the tail,
 * `PlanCard.tsx:8:5`, is an ordinary writable location on its own). That is
 * the RIGHT answer for writeback (editing that `<h3>` really does rewrite
 * `PlanCard.tsx`, for every caller), but the WRONG one for rules 2/3/6: a
 * value read off the loop's own per-item parameter (`{plan.name}`) is
 * data-derived by construction, not a hand-authored literal, regardless of
 * whether its component happens to also have a real file to write to. Since
 * `LOOP_ID_SEPARATOR` only ever gets appended while walking inside a loop
 * iteration (`expandStaticLoop`'s `idSuffix`), and inlining PREPENDS the
 * call-site id (marker included) rather than replacing it, checking for the
 * separator anywhere in the full id is exact, not a heuristic.
 */
function isLoopDerivedNode(nodeId: string): boolean {
  return nodeId.includes(LOOP_ID_SEPARATOR)
}

/**
 * `branchAlternatives` is set on the node the parser SELECTED whenever a
 * multi-return component, a ternary, `&&`, `||` or `??` had more than one
 * possible outcome (`branchSelection.ts`) — see this module's own doc
 * comment for why that is broader than "top-level return" alone.
 */
function checkSingleReturn(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (!node.branchAlternatives || node.branchAlternatives.length === 0) continue
    const labels = node.branchAlternatives.map((a) => a.label).join(', ')
    out.push(
      finding(
        'single-return',
        node,
        `The parser auto-selected this branch over ${node.branchAlternatives.length} other one(s): ${labels}.`,
      ),
    )
  }
}

/**
 * `className` and the `svg` sentinel are excluded here — `className` has its
 * own rule (`static-class-name`) because its acceptable non-literal shape
 * (`styles.x`) differs from an ordinary prop's, and `svg` is markup, not an
 * attribute (`static-svg` covers whether the graphic itself is static).
 * `style:<property>` entries stay IN this rule — a computed inline style
 * value is exactly the same "not a literal, not a const" shape as any other
 * prop, and no dedicated rule exists for it.
 *
 * Skips any `.map`-DERIVED node (`isLoopDerivedNode`): every prop on a loop
 * row — or on a component inlined into one, reading the loop's own per-item
 * parameter — is data-derived by construction, which `const-array-map`
 * already accounts for. Without this exclusion a canonical `.map` over a
 * module-scope const array would ALSO fail `literal-props` on every single
 * row, which is not what the rule means.
 */
function checkLiteralProps(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (isLoopDerivedNode(node.id)) continue
    // `on*` handlers are excluded alongside `className`/`svg`: a handler can
    // never BE a literal, so reporting one says nothing about whether the file
    // is canonical — it would fire on every button in every real screen.
    const violating = (node.codeProps ?? []).filter(
      (p) => p !== 'className' && p !== 'svg' && !/^on[A-Z]/.test(p),
    )
    if (violating.length === 0) continue
    out.push(finding('literal-props', node, `${violating.join(', ')} resolved from a non-literal expression.`))
  }
}

/**
 * `codeText` is set whenever the node's text came from ANY expression rather
 * than a literal JSX child or string-literal expression container — even one
 * that fully resolved to a writable `textOrigin` (a dictionary lookup). That
 * is deliberate: rule 2 (props) allows a module-scope const, but rule 3
 * (text) does not — the WS-13 table states "a literal string in the JSX", no
 * const exception — so `codeText` alone, independent of `textOrigin`, is the
 * right signal.
 */
function checkLiteralText(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (isLoopDerivedNode(node.id)) continue
    if (!node.codeText) continue
    out.push(finding('literal-text', node, "This node's text came from an expression, not a literal JSX child."))
  }
}

/** `DYNAMIC_LOCK_REASON` fires for an unresolvable `.map` AND for any other unresolvable dynamic JSX-producing construct the walk meets (`isLockingExpression`) — not narrowly scoped to `.map` alone. See this module's doc comment. */
function checkConstArrayMap(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (node.lockReason !== DYNAMIC_LOCK_REASON) continue
    out.push(
      finding(
        'const-array-map',
        node,
        'Rendered from a dynamic construct the parser could not read statically — a .map over data reached through props/state/fetch, or another unresolvable call.',
      ),
    )
  }
}

function checkNoSpreadProps(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (node.lockReason !== SPREAD_LOCK_REASON) continue
    out.push(finding('no-spread-props', node, 'This element spreads an arbitrary prop bag ({...rest}).'))
  }
}

/**
 * Fires for ANY non-literal `className`, including the canonical `styles.x`
 * CSS-Modules shape the rule text permits — see this module's own doc
 * comment for why that is correct, not a bug. Skips a `.map`-derived node
 * for the same reason `literal-props` does.
 */
function checkStaticClassName(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (isLoopDerivedNode(node.id)) continue
    if (!(node.codeProps ?? []).includes('className')) continue
    out.push(finding('static-class-name', node, 'className resolved from a non-literal expression.'))
  }
}

/**
 * A relative Sass/Less stylesheet import. Deliberately excludes `.css`/
 * `.module.css` — both are the accepted mechanism. The optional `(?:...from\s+)?`
 * group is required because a stylesheet is almost always imported for its
 * SIDE EFFECT (`import './x.scss'`, no `from` at all) — a plain
 * `from\s+['"]...` pattern misses the common case entirely.
 */
const SASS_LESS_IMPORT_RE = /\bimport\s+(?:[^'";]*\bfrom\s+)?['"][^'"]*\.(?:scss|sass|less)(?:\?[^'"]*)?['"]/
/** A CSS-in-JS package import — matched by specifier, the same way the project probe classifies `styleToolchain.cssInJs`. Always named/default-imported (there is no side-effect-only shape for a component library), but matched with the same optional `from` group for consistency. */
const CSS_IN_JS_IMPORT_RE = /\bimport\s+(?:[^'";]*\bfrom\s+)?['"](?:styled-components|@emotion\/(?:styled|react|css)|@stitches\/react)['"]/

/**
 * Needs `sourceText` (the page's own file, not an inlined component's) —
 * `ParsedNode` carries no import-declaration information. A purely textual
 * scan, matching `tokenExtractTailwind.ts`'s own "no execution" posture: this
 * never parses the file a second time, it only asks whether a banned
 * specifier appears in it.
 *
 * Deliberately does NOT attempt to detect Tailwind utility-class usage — a
 * heuristic over hyphenated `className` strings would be indistinguishable
 * from an ordinary BEM-style class name and would false-positive constantly.
 * Tailwind detection is a PROJECT-level fact (`ProjectProfile.styleToolchain`),
 * not a per-page one; see `docs/reference/canonical-jsx.md`.
 */
function checkSingleStylingMechanism(page: ParsedPage, sourceText: string | undefined, out: CanonicalFinding[]): void {
  if (!sourceText) return
  const anchorId = page.rootIds[0]
  const anchor = anchorId ? page.nodes[anchorId] : undefined
  // No writable node to blame the finding on (an empty parse) — nothing to report against.
  if (!anchor) return

  if (SASS_LESS_IMPORT_RE.test(sourceText)) {
    out.push(findingAt('single-styling-mechanism', anchor.id, anchor.loc, 'Imports a Sass/Less stylesheet, not plain CSS or a CSS Module.'))
  }
  if (CSS_IN_JS_IMPORT_RE.test(sourceText)) {
    out.push(
      findingAt(
        'single-styling-mechanism',
        anchor.id,
        anchor.loc,
        'Imports a CSS-in-JS package (styled-components/emotion/stitches), not plain CSS or a CSS Module.',
      ),
    )
  }
}

/**
 * Reachable, for a JSX-authored `<svg>`, only when the serialized markup
 * exceeds 64 KB — see this module's own doc comment for why an unresolvable
 * ATTRIBUTE does not reach this at all (it is omitted, not failed).
 */
function checkStaticSvg(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (node.lockReason !== DYNAMIC_SVG_LOCK_REASON) continue
    out.push(finding('static-svg', node, 'This <svg> could not be serialized to static markup.'))
  }
}

/**
 * Skipped entirely (no findings) when `componentSources` is not supplied —
 * this rule needs `resolveComponentSources`'s classification, which is a
 * separate pass over the SAME page's ts-morph `SourceFile`, not a
 * `ParsedPage`-only fact.
 */
function checkDirectComponentImports(
  page: ParsedPage,
  componentSources: Record<string, ComponentSource> | undefined,
  out: CanonicalFinding[],
): void {
  if (!componentSources) return
  for (const node of Object.values(page.nodes)) {
    if (node.kind !== 'component') continue
    if (node.id in componentSources) continue
    out.push(
      finding(
        'direct-component-imports',
        node,
        `"${node.name}" could not be traced to a local file or a package import.`,
      ),
    )
  }
}

/**
 * Heuristic (`tier: 'advisory'` for exactly this reason): a node whose sole
 * reason for existing is to group its one child — no props, no inline
 * styles, no text of its own — is a likely inserted wrapper (trap #1). This
 * is a heuristic, not a proof: a wrapper carrying only an event-handler prop
 * (`onClick`) is indistinguishable from one carrying nothing, because a
 * function value is never captured in `props` at all (see
 * `staticValueToPropValue`) — a false positive this rule accepts. Locked
 * nodes are skipped: their structure was not freely chosen by whoever
 * authored this JSX, so flagging them as an "inserted" wrapper would
 * misattribute intent.
 */
function checkNoWrapperElements(page: ParsedPage, out: CanonicalFinding[]): void {
  for (const node of Object.values(page.nodes)) {
    if (node.kind !== 'element') continue
    if (node.locked) continue
    if (node.children.length !== 1) continue
    if (Object.keys(node.props).length > 0) continue
    if (node.inlineStyles && Object.keys(node.inlineStyles).length > 0) continue
    if (node.text !== undefined) continue
    const onlyChild = page.nodes[node.children[0]!]
    if (!onlyChild || (onlyChild.kind !== 'element' && onlyChild.kind !== 'component')) continue
    out.push(
      finding(
        'no-wrapper-elements',
        node,
        `<${node.name}> wraps a single child and carries no attributes of its own — likely an unnecessary wrapper.`,
      ),
    )
  }
}

/**
 * Runs every rule and returns every finding, sorted by source position for a
 * stable, readable report. Never throws — every check above is a plain read
 * over already-parsed data, matching `parsePageFile`'s own never-throw
 * contract; there is nothing here that can fail partway.
 */
export function checkCanonicalJsx(input: CanonicalCheckInput): CanonicalFinding[] {
  const { page, sourceText, componentSources } = input
  const out: CanonicalFinding[] = []

  checkSingleReturn(page, out)
  checkLiteralProps(page, out)
  checkLiteralText(page, out)
  checkConstArrayMap(page, out)
  checkNoSpreadProps(page, out)
  checkStaticClassName(page, out)
  checkSingleStylingMechanism(page, sourceText, out)
  checkStaticSvg(page, out)
  checkDirectComponentImports(page, componentSources, out)
  checkNoWrapperElements(page, out)

  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col)
  return out
}
