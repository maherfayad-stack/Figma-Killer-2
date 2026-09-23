/**
 * detachComponent — WS-4.4, the Figma "detach instance" verb for a LOCAL
 * `studio.instance`. Replaces a component call site (`<Card title="Confirm"
 * onClose={onClose}/>`) with Card's OWN returned JSX, substituted with the
 * call site's argument EXPRESSIONS (source text, never evaluated values —
 * `title={plan.name}` stays a binding), so the page's source ends up exactly
 * as if the author had hand-written Card's markup at that position. After
 * detach, `<Card/>` no longer exists there: the parser will not produce a
 * `studio.instance` node at that location on the next load, and every node
 * detach materialized belongs to the page file, editable without the
 * "changes every instance" warning `fromComponent` used to carry (owner
 * decision OD-9: it still renders, its props no longer apply, and the user
 * can edit anything freely).
 *
 * SYMBOLS, NOT SPELLINGS
 * ----------------------
 * Every identifier in the chosen JSX is resolved with the TypeScript checker
 * in the COMPONENT's file — which declaration it names, not what it is
 * called — and then placed so it names the same thing in the PAGE:
 *
 *  - a destructured PARAM, in ANY expression position (`cn(styles.card,
 *    className)`, `featured && …`, `` `/p/${id}` ``, `{ width: size }`,
 *    `title.toUpperCase()`), becomes the call site's own expression — or the
 *    destructured default, or `undefined` when the call site omitted it,
 *    because that is exactly what an omitted prop IS. An attribute whose whole
 *    value becomes `undefined` is dropped; a string in child position becomes
 *    JSX text (`Confirm`, not `{"Confirm"}`); a string attribute is written
 *    `className="neutral"`, not `className={'neutral'}`;
 *  - a call-site SPREAD (`<Card {...plan}/>`) supplies `plan.title` for every
 *    param no explicit attribute after it sets; the component's own `...rest`
 *    is written out as the call site's leftover attributes (DET-2);
 *  - a body `const` read once by the JSX is inlined as its initializer;
 *  - a name from the component's MODULE scope is imported into the page —
 *    reusing an equivalent import, else under its own name, else ALIASED
 *    (`styles` → `cardStyles`) when the page already means something else by
 *    it — and the rename is exact because it is keyed on the symbol;
 *  - a global stays a global, and must not be shadowed where the text lands.
 *
 * FAILS CLOSED, and says WHY (`DetachRefusal`) rather than guessing. Every
 * refusal leaves both files byte-identical — the plan is built and checked
 * before the first byte changes, and the post-build gate below restores the
 * page's in-memory text before returning. Nothing is saved on any refusal.
 *
 *  - `package-component` / `unresolvable` / `not-a-component` — the call
 *    target is not a local component with a readable declaration.
 *  - `uses-hooks` — a hook needs a component to mount in.
 *  - `maps-over-props` — the JSX `.map`s over one of its own props: inlining
 *    one static copy would drop that data-drivenness.
 *  - `unsupported-params` — an undestructured `props`, a nested destructure,
 *    a prop used somewhere its call-site value cannot be written (a JSX tag
 *    name that is not a component name, a type position).
 *  - `spread-ambiguous` — which value a prop has cannot be known from source:
 *    an explicit attribute BEFORE a spread, two spreads, a spread of a
 *    non-identifier, or a call-site spread into a component that forwards
 *    `...rest`.
 *  - `body-local` — the JSX reads a body value that cannot be inlined (read
 *    more than once, read inside a callback, or computed from other body
 *    state).
 *  - `unbound-reference` — something the JSX needs cannot be bound in the
 *    page (a private module-level helper of the component's file, a name from
 *    the scope around the component), or the post-build gate found a name it
 *    cannot account for.
 *  - `name-collision` — a name would bind to something different in the page
 *    and cannot be aliased: a global the page shadows, a same-file name a
 *    local shadows at the call site, or a call-site expression that one of the
 *    component's own inner bindings would capture.
 *
 * THE GATE. After the plan is written into the page (in memory),
 * `subtreeFreeVariables.ts` re-reads the inserted markup and checks every
 * free name against what the plan promised: a call-site name must bind
 * exactly as it did at the call site, an imported one must bind at module
 * scope, a global must stay unbound. Anything else refuses and restores.
 *
 * A component with more than one JSX-bearing `return` (parser-06) is not
 * refused: `getReturnedJsxRoots` picks the same one the canvas shows, and
 * `DetachSuccess.branchNote` says so.
 */
import { Node, Project, QuoteKind, SyntaxKind, type SourceFile } from 'ts-morph'
import { findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { createWorkspaceProject, getReturnedJsxRoots, type FunctionLike } from '@core/page-parser'
import { resolveComponentCallSite } from './resolveComponentCallSite'
import { applyImportBinding, mirrorSideEffectImports, removeImportIfLastUsage } from './importReconcile'
import { analyzeFreeVariables, bindingKindAt, freeVariablesOutOfScopeAt } from './subtreeFreeVariables'
import { introducesSyntaxErrors } from './reinsertJsxSource'
import { DetachRefusalSignal, fail, readParamTable, type DetachRefusalReason } from './detachSource'
import { DetachPlanner, type DetachPlan } from './detachPlanner'

export type { DetachRefusalReason } from './detachSource'

export interface DetachComponentParams {
  /** Absolute path to the page file holding the call site. */
  file: string
  line: number
  col: number
  /** Absolute path to the workspace root — needed to classify the call target as local vs package. */
  workspaceRoot: string
  /** Optional pre-existing project to reuse (e.g. across multiple edits, or shared with the caller's own project). */
  project?: Project
}


export interface DetachRefusal {
  reason: DetachRefusalReason
  /** Human-readable, suitable for a toast. */
  message: string
}

export interface DetachSuccess {
  ok: true
  /** Set when the component had more than one JSX-bearing return/branch — which one got inlined. */
  branchNote?: string
}

export interface DetachFailure {
  ok: false
  refusal: DetachRefusal
}

export type DetachResult = DetachSuccess | DetachFailure

const HOOK_CALL_RE = /^use[A-Z0-9]/

function refuse(reason: DetachRefusalReason, message: string): DetachFailure {
  return { ok: false, refusal: { reason, message } }
}


/** True if `fn`'s body calls anything shaped like a hook, anywhere (including inside a nested callback — a hook cannot legally be called there either, but the point here is just "this body is not a pure markup function"). */
function usesHooks(fn: FunctionLike): string | undefined {
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    const name = Node.isIdentifier(expr)
      ? expr.getText()
      : Node.isPropertyAccessExpression(expr)
        ? expr.getName()
        : undefined
    if (name && HOOK_CALL_RE.test(name)) return name
  }
  return undefined
}

/** Root identifier of a (possibly chained) member/element access — `items` for `items.map`, `props.items` for `props.items.map`. */
function rootIdentifier(expr: Node): string | undefined {
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return rootIdentifier(expr.getExpression())
  if (Node.isElementAccessExpression(expr)) return rootIdentifier(expr.getExpression())
  return undefined
}

/** True when `root`'s JSX contains a `.map(...)` call whose receiver traces back to one of the component's OWN prop names. */
function mapsOverAnyProp(root: Node, propNames: ReadonlySet<string>): boolean {
  for (const call of root.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'map') continue
    const id = rootIdentifier(expr.getExpression())
    if (id && propNames.has(id)) return true
  }
  return false
}

export interface ParamBinding {
  /** The call site's own attribute name this param forwards, e.g. `{ title }` -> `'title'`; `{ title: t }` -> attrName `'title'`, paramName `'t'`. */
  attrName: string
  /** Verbatim source text of a literal/simple default (`= 'Confirm'`), when the destructure declares one. */
  defaultText?: string
}

/**
 * Reads a component's destructured first-parameter pattern into a
 * name-keyed map, and separately names the `children` binding. The
 * "what props does this component's signature accept" read that
 * `swapComponentInstance` (prop diff) and `addSlotPropToComponent` share. A
 * `...rest` element and a nested pattern are not props this map can name, so
 * they are skipped here; detach reads them itself, by symbol
 * (`readParamTable`).
 */
export function buildParamBindings(fn: FunctionLike): { childrenParam?: string; params: Map<string, ParamBinding>; hasUndestructuredParam: boolean } {
  const params = new Map<string, ParamBinding>()
  let childrenParam: string | undefined
  const first = fn.getParameters()[0]
  if (!first) return { childrenParam, params, hasUndestructuredParam: false }

  const pattern = first.getNameNode()
  if (!Node.isObjectBindingPattern(pattern)) {
    return { childrenParam, params, hasUndestructuredParam: true }
  }

  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) continue
    const nameNode = element.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue
    const paramName = nameNode.getText()
    const propertyNameNode = element.getPropertyNameNode()
    const attrName = propertyNameNode ? propertyNameNode.getText() : paramName
    if (attrName === 'children') {
      childrenParam = paramName
      continue
    }
    const initializer = element.getInitializer()
    params.set(paramName, { attrName, defaultText: initializer?.getText() })
  }
  return { childrenParam, params, hasUndestructuredParam: false }
}


// ---------------------------------------------------------------------------
// The post-build gate
// ---------------------------------------------------------------------------

/**
 * Re-reads the markup as it now sits in the page and checks every free name
 * against the plan. A planning bug that left a component-scope name behind
 * (the pre-DET-1 codemod's whole failure class) is caught here as an
 * `unbound-reference`/`name-collision` instead of being written.
 */
function gateInsertedMarkup(inserted: Node, page: SourceFile, plan: DetachPlan): void {
  for (const variable of analyzeFreeVariables(inserted, page)) {
    const { name } = variable
    const kinds = plan.expected.get(name)
    const now = bindingKindAt(inserted, name, page)
    if (!kinds) {
      fail(
        now === 'none' ? 'unbound-reference' : 'name-collision',
        now === 'none'
          ? `The detached markup would read \`${name}\`, which nothing in the page declares.`
          : `The detached markup would read \`${name}\`, and in the page that name means something else.`,
      )
    }
    if (kinds.has('call-site') && now !== plan.callSiteKinds.get(name)) {
      fail('name-collision', `The call site's \`${name}\` would bind to something else once the markup is inlined.`)
    }
    if (kinds.has('module') && now !== 'module') {
      fail(
        now === 'none' ? 'unbound-reference' : 'name-collision',
        `The detached markup's \`${name}\` would not bind to the import it needs at that position in the page.`,
      )
    }
    if (kinds.has('global') && now !== 'none') {
      fail('name-collision', `The detached markup reads the global \`${name}\`, which the page shadows at that position.`)
    }
  }
  for (const name of freeVariablesOutOfScopeAt(inserted, inserted, page)) {
    const kinds = plan.expected.get(name)
    const unboundBefore = kinds?.has('call-site') && plan.callSiteKinds.get(name) === 'none'
    if (!kinds?.has('global') && !unboundBefore) {
      fail('unbound-reference', `The detached markup would read \`${name}\`, which nothing in the page declares.`)
    }
  }
}

/**
 * Detaches the LOCAL component call site at (file, line, col): writes its
 * own returned JSX at the call site, substituted with the call site's own
 * argument expressions, reconciles imports, and returns `{ok:true}` (the
 * client should reload — a write here always shifts line numbers). Refuses,
 * with a specific reason and with the file untouched, when the target isn't
 * faithfully inlinable — see this module's header.
 */
export function detachComponentInstance(params: DetachComponentParams): DetachResult {
  const { file, line, col, workspaceRoot } = params
  // Unlike this module's siblings (`setJsxProp`, …), this codemod needs
  // CROSS-FILE resolution — the target component's own declaring file, and
  // the checker's view of both files' scopes — so it needs a workspace-wide
  // `Project`, not a single-file `createProject()`.
  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  // New import declarations follow ts-morph's quote-kind setting, not the
  // file's existing style. Default to single quotes (this codebase's own
  // dominant convention); a project that prefers double quotes gets a
  // one-line mismatch a formatter fixes.
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const sourceFile = loadSourceFile(project, file)

  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const fullTagName = opening.getTagNameNode().getText()
  const identifier = fullTagName.split('.')[0]!
  if (!/^[A-Z]/.test(fullTagName)) {
    return refuse('not-a-component', `<${fullTagName}> is a plain HTML element, not a component instance.`)
  }

  const resolved = resolveComponentCallSite(project, sourceFile, workspaceRoot, identifier, file, line, col)
  if (!resolved.ok) {
    if (resolved.failure.reason === 'package-component') {
      return refuse(
        'package-component',
        `${resolved.failure.message} Detaching a package component uses a different action ` +
          '("Eject to local component" / "Replace with markup snapshot"), not yet available.',
      )
    }
    return refuse('unresolvable', resolved.failure.message)
  }
  const { target, fn } = resolved.result

  const hook = usesHooks(fn)
  if (hook) {
    return refuse('uses-hooks', `${identifier} uses ${hook} — detach can't inline a component that uses hooks.`)
  }

  const { childrenParam, params: paramBindings, hasUndestructuredParam } = buildParamBindings(fn)
  if (hasUndestructuredParam) {
    return refuse(
      'unsupported-params',
      `${identifier} takes an undestructured props parameter — detach can't rewrite bare props.x references.`,
    )
  }

  const roots = getReturnedJsxRoots(fn)
  const chosen = roots.find((r) => r.chosen)
  if (!chosen) {
    return refuse('no-renderable-jsx', `${identifier} has no renderable JSX to inline.`)
  }
  const hadAlternatives = roots.some((r) => !r.chosen)

  const restName = readParamTable(fn).rest?.getName()
  const propNames = new Set([...paramBindings.keys(), ...(childrenParam ? [childrenParam] : []), ...(restName ? [restName] : [])])
  if (mapsOverAnyProp(chosen.expr, propNames)) {
    return refuse(
      'maps-over-props',
      `${identifier} maps over one of its own props to render — detach can't inline data-driven content.`,
    )
  }

  const original = sourceFile.getFullText()
  try {
    const plan = new DetachPlanner(project, sourceFile, target.sourceFile, fn, chosen.expr, opening, identifier).plan()
    // Everything below writes the page IN MEMORY only; any refusal restores
    // `original` and nothing reaches the disk.
    const site = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParentOrThrow()
    for (const pending of plan.imports) applyImportBinding(sourceFile, pending.request, pending.local)
    if (target.sourceFile !== sourceFile) mirrorSideEffectImports(sourceFile, target.sourceFile)
    const inserted = site.replaceWithText(plan.siteText)
    gateInsertedMarkup(inserted, sourceFile, plan)
    // Only now — after the call site's own tag reference is actually gone
    // from the tree — is "does anything else in the file still reference
    // Card" decidable.
    removeImportIfLastUsage(sourceFile, identifier)
    if (introducesSyntaxErrors(file, original, sourceFile.getFullText())) {
      throw new Error(`[detachComponent] the detached source for <${identifier}> does not parse — nothing was written.`)
    }
  } catch (err) {
    if (sourceFile.getFullText() !== original) sourceFile.replaceWithText(original)
    if (err instanceof DetachRefusalSignal) return refuse(err.reason, err.message)
    throw err
  }

  sourceFile.saveSync()

  return {
    ok: true,
    ...(hadAlternatives
      ? { branchNote: `${identifier} has more than one rendered state — the currently-shown one was inlined.` }
      : {}),
  }
}
