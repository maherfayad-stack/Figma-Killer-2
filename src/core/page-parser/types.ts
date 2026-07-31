/**
 * Neutral, flat element/instance tree produced by `parsePageFile`.
 *
 * LOCATION CONVENTION (must match `../source-tags` and `../ast-codemods`):
 * a location is 1-based line, 1-based column of the JSX element's tag-name
 * identifier start — the character immediately after `<`.
 */
import type { ValueOrigin } from './staticEvalTypes'
import type { ArrowFunction, FunctionDeclaration, FunctionExpression } from 'ts-morph'

/**
 * A component's own function node — a `function Foo() {}` declaration, an
 * arrow (`const Foo = () => {}`), or a function expression assigned to a
 * `const`. Lives here (not in `parsePageFile.ts`) so `staticEval.ts` can
 * depend on the type without importing the parser module itself — the parser
 * imports the evaluator's runtime exports, so a reverse type-only edge back
 * from parsePageFile would be a needless cycle risk. `parsePageFile.ts`
 * re-exports this for its existing consumers (`inlineLocalComponents.ts`, the
 * barrel).
 */
export type FunctionLike = ArrowFunction | FunctionDeclaration | FunctionExpression

/**
 * A value a prop can hold. Scalars are the whole story for an HTML element —
 * an attribute is a string — but a COMPONENT prop is routinely an array of
 * objects (`<ActionSheet actions={[{ label }, { label }]}/>`), and dropping
 * those left real design-system components rendering their title and nothing
 * else. See `extractProps` for why only component props are captured
 * structurally.
 *
 * JSON-shaped on purpose: this crosses HTTP to the editor as `PageNode.props`.
 * A function-valued entry (`onClick`) has no JSON form and is dropped, not
 * stubbed — see `staticValueToPropValue`.
 */
export type ParsedPropValue =
  | string
  | number
  | boolean
  | readonly ParsedPropValue[]
  | { readonly [key: string]: ParsedPropValue }

export interface NodeLoc {
  /** appDir-relative POSIX path. */
  file: string
  line: number
  col: number
}

/**
 * One branch the parser did NOT select, recorded on the node it DID select —
 * see `ParsedNode.branchAlternatives` and `getReturnedJsxRoots`/
 * `selectJsxBranch` in `parsePageFile.ts` (parser-06, extended to `&&` by
 * parser-07).
 *
 * Deliberately just a pointer (a label + where it lives), not a materialized
 * subtree: the alternative was never walked into `ParsedNode`s, so it costs
 * nothing in node count, never shows up in a fidelity walk of `page.nodes`,
 * and can't drift from what `nodeIds`-style bookkeeping would need to keep in
 * sync. A branch picker reads `loc` to point the user at the source, the same
 * way `textOrigin`/`assetOrigin` point at a literal without the JSX itself
 * being a node.
 *
 * For a multi-return component or a ternary, `loc` is a genuinely different
 * piece of source the parser never walked. For an unresolvable `&&`
 * (parser-07) there is no separate "other branch" — only a shown/hidden
 * toggle on the ONE JSX that exists — so `loc` points at that same JSX,
 * labelled as the hidden state, rather than at nothing.
 */
export interface BranchAlternative {
  /**
   * Human label for this branch, derived from its own guard `if` condition
   * (`"loading"`, `"!items.length"`) or a ternary/`&&`'s condition text —
   * whatever a person reading the source would call it. Falls back to a
   * positional name (`"branch 2"`) when no guard expression could be read.
   */
  label: string
  /** Where this branch's own JSX begins. */
  loc: NodeLoc
}

export interface ParsedNode {
  /** `${relFilePosix}:${line}:${col}` — deterministic. */
  id: string
  /** lowercase tag name = 'element'; Capitalized = 'component'. */
  kind: 'element' | 'component'
  /** Tag name / component identifier, e.g. "div" or "Button". */
  name: string
  /**
   * Literal attributes, plus whatever §7's evaluator resolved. Scalars for
   * every element; a COMPONENT may also carry an array/object value — see
   * `ParsedPropValue`. An expression that does not resolve is skipped.
   */
  props: Record<string, ParsedPropValue>
  /**
   * The element's `style={{ … }}` object-literal attribute, flattened to its
   * literal (string/number) entries so the canvas can render the real
   * inline styles authored in source. Non-literal values (identifiers, calls,
   * spreads) inside the object are skipped. Absent when the element has no
   * `style` attribute or none of its entries are literals.
   */
  inlineStyles?: Record<string, string | number>
  /** Child node ids, in source order. */
  children: string[]
  loc: NodeLoc
  /**
   * true = this node's STRUCTURE is code-controlled: it may not be moved,
   * deleted, reordered, or wrapped, because the source does not place it — a
   * `.map` generated it, a ternary/`&&` chose it, a spread supplies its props.
   *
   * Deliberately NOT a statement about its values. Which branch of a conditional
   * renders has nothing to do with whether `title="Where to?"` on that branch's
   * element is a writable literal attribute — it is one, at a known line and
   * column. Value writability is per-prop and lives in `codeProps` below.
   */
  locked: boolean
  lockReason?: string
  /**
   * The prop names on this node whose value is CODE rather than a literal
   * attribute at this element — so writing an edit back would overwrite an
   * expression and destroy what it reads. Inline-style entries appear as
   * `style:<property>`.
   *
   * This is the per-prop half of what `locked` used to do wholesale. A node
   * locked for a structural reason (branch, spread, `.map`) had EVERY prop
   * refused, silently, which is how an imported app ended up with a properties
   * panel that showed the right values in live-looking inputs and threw away
   * every keystroke. Three quarters of those props are ordinary literal
   * attributes that `setJsxProp` can rewrite precisely.
   *
   * A prop is code-valued when §7's evaluator had to resolve it
   * (`title={c.sheetTitle}`), or when it holds a structured/JSX value that has
   * no scalar source form at all (`actions={[…]}`, `icon={<Icon/>}`).
   *
   * The node's TEXT is included here, under the module's own text prop name,
   * only once `studio-sync` maps it — and only when it has no writable
   * `textOrigin`. See `parsedPageToSitePage`.
   */
  codeProps?: string[]
  /**
   * True when the element's `text` came from an expression rather than a literal
   * JSX child. Consumed by `studio-sync`, which knows the module's text prop
   * name and folds this into `PageNode.codeProps` — unless `textOrigin` gives
   * the edit somewhere honest to land.
   */
  codeText?: boolean
  /**
   * The element's text content, captured ONLY when its meaningful children
   * are exactly one non-whitespace `JsxText` node or one string-literal
   * expression container (`{"..."}` / `{'...'}`) — the same "text-only leaf"
   * shape `../ast-codemods/setJsxText` is willing to overwrite. Elements with
   * element children, more than one meaningful child, or a non-literal
   * expression child get no `text` (their `children` are still walked
   * structurally as before). Absent for locked/dynamic-surface nodes.
   * Trimmed of leading/trailing whitespace only (approximates JSX's own
   * insignificant-whitespace collapsing).
   */
  text?: string
  /**
   * Present only when a value in `props`/`inlineStyles`/`text` came from §7's
   * static evaluator resolving a non-literal expression (`{t.homepage.greeting}`,
   * a cross-file `const`, a hook's traced provider value, a dictionary index
   * with a dynamic key, a resolvable pure-arrow call, …) rather than a literal
   * already sitting in the source. `source` is the short original expression
   * text (e.g. `"t.homepage.greeting"`); `note` records a resolution choice
   * worth surfacing in the editor (e.g. picking a locale/branch for a
   * dynamically-indexed dictionary — see `staticEval.ts`'s Tier B.4).
   *
   * A node carrying `resolution` is USUALLY also `locked`, with a
   * `lockReason: 'value from <source>'` — writing an edited literal back over
   * `{t.homepage.greeting}` would silently destroy the original binding in
   * the user's real source file, so the value is read-only, same principle as
   * `locked`/`lockReason` above. `textOrigin` below is one exception (it
   * writes somewhere else entirely); `applyAsyncServerComponentFinding`
   * (`nextAppLayout.ts`) and the multi-return/ternary/`&&` branch CHOICE
   * below (`branchAlternatives`) are the other two — both attach this same
   * `{source, note}` shape to explain a STRUCTURAL fact the parser is
   * certain of, not a value it is protecting from a baked-over write, so
   * neither locks the node. See each site's own comment for why.
   */
  resolution?: { source: string; note?: string }
  /**
   * Present on the node the parser SELECTED when a component had more than
   * one JSX-bearing `return`, or a JSX child was a ternary/`&&` — see
   * `getReturnedJsxRoots`/`selectJsxBranch` in `parsePageFile.ts`. Lists the
   * branch(es) NOT shown, each just a label + source location (see
   * `BranchAlternative`'s own doc comment for why nothing is materialized).
   *
   * Deliberately does NOT lock the node: the parser is certain of the
   * STRUCTURE here (there really is exactly one element at this line and
   * column) — it only chose which of several runtime states to show by
   * default. That is a different fact from a resolved VALUE, which `locked`
   * exists to protect a writeback target for.
   */
  branchAlternatives?: BranchAlternative[]
  /**
   * Where this node's TEXT literally lives, when its text was resolved from an
   * expression and that expression bottomed out in a single string literal
   * inside the workspace: `{c.hotelsTag}` -> `hotelsTag: 'Exclusive rates on
   * hotels'` in `src/i18n/translations.js`.
   *
   * This is what makes resolved copy editable. The JSX is NOT a writeback
   * target — replacing `{c.hotelsTag}` with a string would destroy the i18n
   * binding — but the literal it reads is an ordinary string in a source file,
   * and rewriting it in place is exactly what a person editing that copy means.
   *
   * Deliberately scoped to TEXT rather than hung off `resolution`. A node can
   * resolve several values (text, `className`, an aria label) and `resolution`
   * keeps only the first, so an origin there could point at the literal behind a
   * DIFFERENT prop than the one being edited — and a writeback aimed at the
   * wrong string is worse than no writeback at all.
   *
   * Absent when the text is computed rather than passed through (a template
   * literal, a concatenation, a function's return value): there is no single
   * literal to rewrite. See `ValueOrigin`.
   */
  textOrigin?: ValueOrigin
  /**
   * Where an IMPORTED IMAGE's own module-specifier string literal lives, when
   * one of this node's props resolved to a `studio-asset:` sentinel through
   * `resolveImageAssetImport` (WS-8.3): `<img src={heroImg}/>` ->
   * `import heroImg from './hero.png'` -> this points at `'./hero.png'`.
   *
   * The exact same trick as `textOrigin` above, applied to a different literal
   * shape: the JSX is never the writeback target (writing a baked path over
   * `src={heroImg}` would delete the binding), but the import statement one
   * hop away is an ordinary string literal at a known position, and
   * `setImportSpecifier` rewrites exactly that. Absent when the prop resolved
   * to something other than a traceable image import (a literal `src="..."`
   * needs no origin — `setJsxProp` already writes it directly — or the import
   * could not be traced to a real file inside the workspace at all).
   *
   * Scoped to the FIRST such prop found, same "only one, deliberately" policy
   * as `textOrigin` — see its doc comment for why picking more than one would
   * risk pointing an edit at the wrong prop's literal.
   */
  assetOrigin?: ValueOrigin
  /**
   * Set on every node produced by inlining a local component (§2), naming the
   * component it came from (`'SheetHeader'`). Provenance, NOT a lock: the node
   * is editable, and its writeback target is that component's own source
   * location — the tail of the composite id (see `studioEditLocation`).
   *
   * It exists because that file backs EVERY instance of the component, so one
   * edit changes all of them. The editor shows a warning carrying this name
   * and the instance count before the user commits. Nested inlining keeps the
   * INNERMOST component's name — that is the file an edit actually writes to.
   */
  fromComponent?: string
  /**
   * WS-4.2 — present on a component CALL SITE that `inlineLocalComponents`
   * successfully expanded. Turns this node into the "instance" fragment
   * model: `children` is the inlined subtree's roots (what used to replace
   * the call site outright — see `inlineLocalComponents`'s module header),
   * and this field is the provenance + call-site prop surface that makes the
   * redesign worth doing — call-site props become editable (§4.3), and
   * detach/swap (§4.4/4.5) have something to act on.
   *
   * Absent when a `kind: 'component'` call site was NOT expanded (declined —
   * cycle, missing declaration, depth/node cap) — that node stays exactly as
   * `parseJsxTree` produced it, unchanged from pre-WS-4 behaviour, so
   * `resolveModuleId` can tell the two cases apart and keep the honest
   * "Unknown module" fallback for a genuinely-declined call site.
   */
  instanceOf?: {
    /** The component's own display name, e.g. `'Card'` — same string `fromComponent` uses for its descendants. */
    componentName: string
    /** Only `'local'` is ever produced by this parser today; `'package'` is reserved for a future package-instance unification (see WS-4's doc). */
    source: 'local' | 'package'
    /** Workspace-relative POSIX path of the component's OWN declaring file, or `null` when not applicable. */
    sourceFile: string | null
    /**
     * The call site's own literal/resolved prop values — e.g. `<Card
     * title="Confirm"/>`'s `{ title: "Confirm" }`. Distinct from `props`
     * (this node's OWN top-level props, which for an instance node are the
     * four `instanceOf` fields mirrored by `parsedPageToSitePage` — see that
     * module) so a call-site prop's writability can be asked with the
     * `callSiteProps:<name>` `codeProps` convention (parallel to
     * `style:<property>`), without inventing a new predicate.
     */
    callSiteProps: Record<string, ParsedPropValue>
  }
}

export interface ParsedPage {
  rootIds: string[]
  nodes: Record<string, ParsedNode>
}
