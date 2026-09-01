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
   * `ParsedPropValue`. An expression that does not resolve has no VALUE here
   * — there genuinely isn't one to show — but its NAME still lands in
   * `codeProps` below (with the sole exception of a JSX-attribute `{...spread}`,
   * whose set of resulting keys is unknowable and so has no name to record).
   * "Not in `props`" therefore no longer means "the source has nothing here";
   * check `codeProps` before assuming that.
   */
  props: Record<string, ParsedPropValue>
  /**
   * The element's `style={{ … }}` object-literal attribute, flattened to its
   * literal (string/number) entries so the canvas can render the real
   * inline styles authored in source. A non-literal value (an identifier, a
   * call, a template, …) inside the object has no entry here either, but its
   * property name still lands in `codeProps` as `style:<property>` — the same
   * "no value, but a name" rule `props` follows above, for the identical
   * write-safety reason (see `codeProps`'s own doc comment). A property set
   * by a SPREAD element inside the object (`{ ...base, color: 'red' }`) is the
   * one exception: its keys are unknowable, so nothing can be named. Absent
   * entirely when the element has no `style` attribute or it isn't a plain
   * object literal.
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
  /**
   * Why the STRUCTURE is code-controlled, phrased to be read by a person
   * ("item 2 of DEALS", "spread props"). Present only when `locked` — a
   * resolved VALUE is explained by `resolution` + `codeProps` instead, and
   * never produces a lock reason. Every surface that renders this phrase
   * (`SourceConstraintNotice`, `propLockReason`, the fidelity report) treats
   * its presence as "this element cannot be moved or deleted".
   */
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
   * (`title={c.sheetTitle}`), when it holds a structured/JSX value that has no
   * scalar source form at all (`actions={[…]}`, `icon={<Icon/>}`), OR — the
   * catch-all `extractProps`/`extractInlineStyles` fall through to when
   * NOTHING above could resolve the expression at all (an identifier bound to
   * hook state, a member/element-access chain, an unresolvable template/
   * ternary/call, a JSX-valued prop on an HTML element). That third case
   * carries no value in `props`/`inlineStyles` either — there genuinely isn't
   * one — but the NAME is recorded regardless, because an absent `codeProps`
   * entry reads as "writable" to `isPropWritableToSource`, and `setJsxProp`
   * has no guard against baking a literal straight over a non-literal
   * attribute it was never shown. The one shape with no name to record at all
   * is a `{...spread}` attribute (or a spread element inside a `style={{…}}`
   * object): its resulting keys are unknowable, so there is nothing to file a
   * trace under — that gap is real, not an oversight, and is covered instead
   * by the node's structural `lockReason`/`locked` (a spread attribute always
   * sets one; a spread INSIDE a style object does not, since it says nothing
   * about whether the ELEMENT itself has a single honest position to write
   * to).
   *
   * The node's TEXT is included here, under the module's own text prop name,
   * only once `studio-sync` maps it — and only when it has no writable
   * `textOrigin`. See `parsedPageToSitePage`. `codeText` below is the
   * page-parser-level signal that feeds that mapping.
   */
  codeProps?: string[]
  /**
   * Paths to a FUNCTION found nested inside a resolved object/array prop
   * value — a dot for an object key, `[N]` for an array index, prefixed with
   * the prop's own name: `<Navbar toolbar={{ title, onBack: () => {} }}/>`
   * yields `['toolbar.onBack']`.
   *
   * `props`/`codeProps` already tell the truth about the OBJECT itself
   * (`toolbar` lands in `codeProps` because it is a structured, non-scalar
   * value with no writeback target — see `codeProps`'s own doc above) — this
   * field is a narrower, different fact: WHERE inside that object a function
   * was written, which `staticValueToPropValue` correctly drops from the JSON
   * value (there is no JSON form for `() => {}`) but which several
   * design-system components gate a visible affordance on. A `BottomSheet`
   * draws its close button when handed a top-level `onClose`; a `Navbar`
   * draws its leading back button when handed a NESTED `toolbar.onBack` — the
   * parser can hand over neither function, but it can say exactly where one
   * was written, so `src/modules/alm/register.tsx` can stand a no-op back up
   * at precisely that path (never anywhere the source did not write one — see
   * that module's own doc comment).
   *
   * Deliberately a COMPANION field, not folded into `codeProps`. Every entry
   * here sits under a prop name already present in `codeProps` (the whole
   * object is never writable regardless of what is nested inside it), so a
   * nested path answers no writability question `isPropWritableToSource`
   * doesn't already answer at the top level — it exists purely so a module can
   * reconstruct a render-time no-op, and folding it into `codeProps` would
   * only double-report the same prop to `canonicalCheck.ts`'s `literal-props`
   * advisory for no new information.
   */
  codeFunctionPaths?: string[]
  /**
   * True when the element's sole child WAS an expression rather than a
   * literal JSX child — regardless of whether §7 could resolve it to a value.
   * Set for BOTH cases: a resolution that produced `text` (`{c.heading}`) and
   * one that produced nothing at all (`{formatMessage(id)}`, `{user.name}` off
   * unresolvable hook state — see `extractSingleText`'s `hasCodeText`). The
   * two are NOT the same fact downstream — only the first also carries a
   * `text` value for the canvas to show — but they share this one field
   * because `studio-sync` needs to know "code decided this, at all" before it
   * can decide whether it also has something to display: it knows the
   * module's text prop name and folds this into `PageNode.codeProps` — unless
   * `textOrigin` gives the edit somewhere honest to land. **KNOWN GAP:**
   * `parsedPageToSitePage`'s fold currently only fires when `node.text !==
   * undefined`, so the unresolved case (`text` absent, `codeText` true) does
   * not yet reach `PageNode.codeProps` — the trace exists at THIS layer, but
   * needs a companion change in `studio-sync` to fully surface in the panel.
   * See STATE.md `board-27b`.
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
   * **Carrying a `resolution` never locks the node.** Writing an edited literal
   * back over `{t.homepage.greeting}` would silently destroy the binding in the
   * user's real source file — but that is a fact about ONE VALUE, recorded
   * per-prop in `codeProps` by the same reader that recorded the resolution
   * (and in `codeText` for text, unless `textOrigin` names a literal that IS an
   * honest target). The element itself is written at a known line and column,
   * so moving, reordering or deleting it stays a precise, single-target edit.
   * `applyAsyncServerComponentFinding` (`nextAppLayout.ts`) and the
   * multi-return/ternary/`&&` branch CHOICE (`branchAlternatives` below) attach
   * this same `{source, note}` shape for the same reason. See `withResolution`
   * in `./nodeResolution` for the full history — locking here is what made 54%
   * of a real board's locks say something false about the element.
   */
  resolution?: { source: string; note?: string }
  /**
   * R2 (`STUDIO-FIGMA-PARITY-PLAN.md` §9/F2) — the per-VALUE counterpart of
   * `resolution` above. `resolution` keeps only the FIRST resolved value on a
   * node (`withResolution`'s `resolutions[0]`), so a node with two code-valued
   * props showed one real source and a generic "set in code" fallback for the
   * other — see `docs/audits/2026-08-06/09-refusal-states.md` finding R2.
   *
   * Keyed exactly like `codeProps`: a prop name (`"title"`), a `style:<property>`
   * inline-style entry, or the literal key `"text"` for the node's own captured
   * text. Every key present here has a matching `codeProps` entry — this map
   * only ever explains a value that is ALSO refused; it does not gate anything
   * itself (`isPropWritableToSource`/`isStyleWritableToSource` still own that
   * decision, unchanged). Built by `shortenResolutionMap` in `./nodeResolution`.
   */
  resolvedProps?: Record<string, { source: string; note?: string; origin?: ValueOrigin }>
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
  /**
   * E2.3 — present when this node is the materialized container for a
   * FRAGMENT-valued component-prop slot (`header={<><Back/><Title/></>}`),
   * minted by `captureSlotProps`'s fragment branch in `parsePageFile.ts`.
   *
   * A single-element slot value (`icon={<Icon/>}`) needs no marker — it mints
   * an ordinary node via the same `processElement` walk every child goes
   * through, and `resolveModuleId` picks its module the usual way. A fragment
   * has no tag name to dispatch on, so this field is how `resolveModuleId`
   * (`server/handlers/studioPageLoad.ts`) recognizes it and maps it to
   * `studio.slot` — the zero-DOM `<>{children}</>` module
   * (`src/modules/studio/slot/`) that mirrors `studio.instance`'s reasoning
   * one prop-value down instead of one call-site down.
   *
   * The node's own `id` is the `JsxFragment`'s OWN source location, never a
   * minted id — see `captureSlotProps`'s doc comment for why: a minted id
   * would make `refuseMintedNodeInsert` correctly (but for the wrong stated
   * reason) refuse every future insert into a multi-element slot.
   */
  fragmentSlot?: true
}

export interface ParsedPage {
  rootIds: string[]
  nodes: Record<string, ParsedNode>
}
