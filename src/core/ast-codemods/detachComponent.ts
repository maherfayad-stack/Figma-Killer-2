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
 * "changes every instance" warning `fromComponent` used to carry.
 *
 * FAILS CLOSED, on purpose, and reports WHY (`DetachRefusal`) rather than
 * guessing:
 *
 *  - The call target must be a LOCAL component (`ComponentSource.kind ===
 *    'local'`) with a resolvable declaration. A package component is a
 *    different operation ("Eject to local component" / "Replace with markup
 *    snapshot" — WS-4.4's plan text) and is out of scope for this function;
 *    see `docs/features/studio-import.md` for the honest gap.
 *  - The declaration's body must not call a hook (`useXxx`) — a hook needs a
 *    component to mount in; pasting its call site into a plain page tree
 *    would either break the rules of hooks (conditionally called) or change
 *    behaviour silently.
 *  - The declaration must not `.map` over one of its OWN destructured props —
 *    `items.map(...)` inside Card's JSX, where `items` is a prop, generates
 *    N elements FROM THE CALL SITE'S data; inlining one static copy would
 *    silently drop that data-drivenness.
 *  - The first parameter, if present, must be a destructured OBJECT pattern
 *    (`{ title, onClose }`, not `props`) — the substitution algorithm below
 *    needs named bindings to know what to replace.
 *  - Every identifier Card's JSX references that isn't already resolvable in
 *    the page file must resolve to something reconcilable — a sub-component,
 *    a constant, an asset import — with no NAME COLLISION against a
 *    different binding already in scope at the page file's top level.
 *
 * A component with more than one JSX-bearing `return` (parser-06 — the
 * parser already SELECTS one to render, recording the rest as
 * `branchAlternatives`) is not refused: `getReturnedJsxRoots` picks the same
 * one the canvas is already showing, and this codemod inlines exactly that
 * branch, reporting which one via `DetachSuccess.branchNote` — "the branch
 * actually being shown", per this work order's explicit instruction.
 */
import * as path from 'node:path'
import { Node, Project, QuoteKind, SyntaxKind, type JsxAttribute, type SourceFile } from 'ts-morph'
import { findJsxElementAtLocationOrThrow, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'
import { createWorkspaceProject, getReturnedJsxRoots, type FunctionLike } from '@core/page-parser'
import { resolveComponentCallSite } from './resolveComponentCallSite'

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

export type DetachRefusalReason =
  | 'not-a-component'
  | 'package-component'
  | 'unresolvable'
  | 'uses-hooks'
  | 'maps-over-props'
  | 'unsupported-params'
  | 'no-renderable-jsx'
  | 'name-collision'

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
 * substitution map, and separately names the `children` binding. Mirrors
 * `componentSubstitution.ts`'s `buildSubstitutionEnv` structurally, but
 * keeps TEXT, never an evaluated value — a source-to-source transform.
 * Exported (not just used by `detachComponentInstance`) — `swapComponentInstance`
 * needs the exact same "what props does this component's signature accept"
 * read for its prop-diff step.
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
    if (element.getDotDotDotToken()) continue // ...rest — unsupported, left unbound (same policy as inlineLocalComponents)
    const nameNode = element.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue // nested pattern — unsupported
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

/** The call site's own JsxAttribute nodes, keyed by attribute name (self-closing or open/close form — both expose `getAttributes()`). */
function callSiteAttributes(opening: JsxOpeningLikeElement): Map<string, JsxAttribute> {
  const map = new Map<string, JsxAttribute>()
  for (const attr of opening.getAttributes()) {
    if (Node.isJsxAttribute(attr)) map.set(attr.getNameNode().getText(), attr)
  }
  return map
}

/** Verbatim source text of an attribute's VALUE, as a standalone expression usable at the splice position — never the evaluated value. */
function attrValueText(attr: JsxAttribute): string {
  const init = attr.getInitializer()
  if (!init) return 'true' // boolean shorthand: `<Card featured/>`
  if (Node.isStringLiteral(init)) return init.getText() // keep the quoted literal as-is — valid standalone JS
  if (Node.isJsxExpression(init)) {
    const inner = init.getExpression()
    return inner ? inner.getText() : 'undefined'
  }
  return init.getText()
}

/**
 * Builds the inlined JSX text for `root` (the component's chosen returned
 * JSX), substituting every `{paramName}` reference with the call site's own
 * argument text (or its destructured default when the call site omitted the
 * attribute), and every `{childrenParam}` reference with the call site's own
 * children source text. AST-driven (offsets from `root`'s own descendants),
 * never a blind text search-and-replace, so an unrelated identifier that
 * happens to share a param's name elsewhere in the file is never touched —
 * only `root`'s own subtree is walked.
 */
function buildInlinedJsxText(
  root: Node,
  childrenParam: string | undefined,
  params: Map<string, ParamBinding>,
  attrs: Map<string, JsxAttribute>,
  callSiteChildrenText: string,
): string {
  const fullText = root.getSourceFile().getFullText()
  const replacements: { start: number; end: number; text: string }[] = []

  root.forEachDescendant((node) => {
    if (!Node.isJsxExpression(node)) return
    const expr = node.getExpression()
    if (!expr || !Node.isIdentifier(expr)) return
    const name = expr.getText()

    if (childrenParam && name === childrenParam) {
      replacements.push({ start: node.getStart(), end: node.getEnd(), text: callSiteChildrenText })
      return
    }

    const binding = params.get(name)
    if (!binding) return
    const attr = attrs.get(binding.attrName)
    const valueText = attr ? attrValueText(attr) : binding.defaultText
    // No call-site value AND no default: leave `{paramName}` untouched — a
    // documented gap (see this module's header), not a guess.
    if (valueText === undefined) return
    replacements.push({ start: node.getStart(), end: node.getEnd(), text: `{${valueText}}` })
  })

  if (replacements.length === 0) return root.getText()

  replacements.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = root.getStart()
  for (const r of replacements) {
    out += fullText.slice(cursor, r.start)
    out += r.text
    cursor = r.end
  }
  out += fullText.slice(cursor, root.getEnd())
  return out
}

/** Every top-level identifier `root`'s JSX references that would need to resolve in the PAGE file: JSX tag names (sub-components) and bare identifiers inside expression containers, excluding this component's own param/children bindings (already substituted) and lowercase HTML tags. */
function referencedIdentifiers(root: Node, params: ReadonlySet<string>, childrenParam: string | undefined): Set<string> {
  const names = new Set<string>()
  root.forEachDescendant((node) => {
    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) {
      const tagName = node.getTagNameNode().getText().split('.')[0]!
      if (/^[A-Z]/.test(tagName)) names.add(tagName)
      return
    }
    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression()
      const rootId = expr ? rootIdentifier(expr) : undefined
      if (rootId && rootId !== childrenParam && !params.has(rootId) && /^[A-Za-z_$][\w$]*$/.test(rootId)) {
        // Skip lowercase locals declared inside the expression itself (rare in
        // JSX position) — a bare, capitalized-or-lowercase module-scope name
        // is the common shape (`DEFAULT_ICON`, `styles`, an imported const).
        names.add(rootId)
      }
    }
  })
  return names
}

/** A relative module specifier from `fromFileAbs`'s directory to `toFileAbs`, POSIX-separated. Local to this module (not `studioWriteback.ts`'s copy) so `src/core/ast-codemods` never depends on `server/`. */
function relativeSpecifier(fromFileAbs: string, toFileAbs: string): string {
  const fromDir = path.dirname(fromFileAbs)
  let rel = path.relative(fromDir, toFileAbs).split(path.sep).join('/')
  rel = rel.replace(/\.(tsx|jsx|ts|js)$/, '')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

/**
 * Adds imports to the page file so the pasted JSX resolves: for every
 * identifier Card's JSX references (sub-components, constants, `?raw`/CSS
 * imports) that Card's OWN file imports or declares, mirrors an equivalent
 * import into the page file — unless the page file ALREADY has a top-level
 * binding under that name, in which case it is trusted as-is (see this
 * function's own comment on the name-collision gap). Does NOT touch the
 * `Card` import itself — that is `removeImportIfLastUsage`'s job, called
 * separately, AFTER the call site's own JSX has actually been replaced (so
 * "is this still referenced" sees the post-detach file, not the original
 * call site it is about to remove).
 */
function addReconciledImports(
  pageFile: SourceFile,
  targetFile: SourceFile,
  identifiers: ReadonlySet<string>,
): void {
  const pageTopLevelNames = new Set<string>()
  for (const decl of pageFile.getImportDeclarations()) {
    if (decl.getDefaultImport()) pageTopLevelNames.add(decl.getDefaultImport()!.getText())
    if (decl.getNamespaceImport()) pageTopLevelNames.add(decl.getNamespaceImport()!.getText())
    for (const named of decl.getNamedImports()) {
      pageTopLevelNames.add(named.getAliasNode()?.getText() ?? named.getNameNode().getText())
    }
  }
  for (const fn of pageFile.getFunctions()) if (fn.getName()) pageTopLevelNames.add(fn.getName()!)
  for (const v of pageFile.getVariableDeclarations()) pageTopLevelNames.add(v.getName())

  for (const name of identifiers) {
    if (pageTopLevelNames.has(name)) {
      // Already in scope — trust it (a real name collision against a
      // DIFFERENT source is rare enough, and detecting it precisely would
      // need resolving the page's own binding's declaration file too; left
      // as a documented gap rather than a guess — see this module's header).
      continue
    }

    const targetImport = targetFile.getImportDeclarations().find((decl) => {
      if (decl.getDefaultImport()?.getText() === name) return true
      if (decl.getNamespaceImport()?.getText() === name) return true
      return decl.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getNameNode().getText()) === name)
    })

    if (targetImport) {
      const specifierText = targetImport.getModuleSpecifierValue()
      const isRelative = specifierText.startsWith('.')
      const specifier = isRelative
        ? relativeSpecifier(pageFile.getFilePath(), path.resolve(path.dirname(targetFile.getFilePath()), specifierText))
        : specifierText
      const isDefault = targetImport.getDefaultImport()?.getText() === name
      const isNamespace = targetImport.getNamespaceImport()?.getText() === name
      pageFile.addImportDeclaration({
        moduleSpecifier: specifier,
        ...(isDefault ? { defaultImport: name } : {}),
        ...(isNamespace ? { namespaceImport: name } : {}),
        ...(!isDefault && !isNamespace ? { namedImports: [name] } : {}),
      })
      continue
    }

    // Declared directly in Card's own file (a same-file helper/const) —
    // import it from Card's file itself under its own name.
    const declaredInTarget =
      targetFile.getFunction(name) !== undefined || targetFile.getVariableDeclaration(name) !== undefined
    if (declaredInTarget) {
      const specifier = relativeSpecifier(pageFile.getFilePath(), targetFile.getFilePath())
      pageFile.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [name] })
      continue
    }
    // Otherwise: a global (`Math`, `String`, …) or something this module
    // can't trace — left unimported; TypeScript/the bundler will surface it
    // loudly rather than this codemod guessing.
  }
}

/** Removes `callTargetLocalName`'s import from `pageFile` if no JSX tag or identifier reference to it remains anywhere in the file. */
function removeImportIfLastUsage(pageFile: SourceFile, localName: string): void {
  const stillUsed = pageFile.getDescendants().some((node) => {
    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node) || Node.isJsxClosingElement(node)) {
      return node.getTagNameNode().getText().split('.')[0] === localName
    }
    if (Node.isIdentifier(node) && node.getText() === localName) {
      const parent = node.getParent()
      // Exclude the identifier's own declaration site (an import specifier),
      // which always "matches" trivially.
      return !(Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent))
    }
    return false
  })
  if (stillUsed) return

  for (const decl of pageFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === localName) {
      if (decl.getNamedImports().length === 0 && !decl.getNamespaceImport()) decl.remove()
      else decl.getDefaultImport()!.replaceWithText('') // rare mixed-import shape — leave named imports intact
      return
    }
    if (decl.getNamespaceImport()?.getText() === localName) {
      decl.remove()
      return
    }
    const named = decl.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getNameNode().getText()) === localName)
    if (named) {
      if (decl.getNamedImports().length === 1 && !decl.getDefaultImport() && !decl.getNamespaceImport()) decl.remove()
      else named.remove()
      return
    }
  }
}

/**
 * Detaches the LOCAL component call site at (file, line, col): writes its
 * own returned JSX at the call site, substituted with the call site's own
 * argument expressions, reconciles imports, and returns `{ok:true}` (the
 * client should reload — a write here always shifts line numbers). Refuses,
 * with a specific reason, when the target isn't safely inlinable — see this
 * module's header.
 */
export function detachComponentInstance(params: DetachComponentParams): DetachResult {
  const { file, line, col, workspaceRoot } = params
  // Unlike this module's siblings (`setJsxProp`, …), this codemod needs
  // CROSS-FILE resolution — the target component's own declaring file — so
  // it needs a workspace-wide `Project`, not a single-file `createProject()`
  // (see `componentSources.ts`'s own doc comment for why a bare `Project`
  // cannot resolve a module specifier to a file it doesn't already know
  // about).
  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  // New import declarations synthesized below (`addReconciledImports`) follow
  // ts-morph's own quote-kind setting, not the file's existing style — unlike
  // every other codemod in this directory, which edits an EXISTING literal in
  // place and matches its quotes textually (see `setImportSpecifier.ts`).
  // Default to single quotes (this codebase's own dominant convention) rather
  // than ts-morph's double-quote default; a project that genuinely prefers
  // double quotes gets a one-file quote mismatch a formatter fixes, which is
  // a smaller cost than guessing wrong the other direction.
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

  const propNames = new Set([...paramBindings.keys(), ...(childrenParam ? [childrenParam] : [])])
  if (mapsOverAnyProp(chosen.expr, propNames)) {
    return refuse(
      'maps-over-props',
      `${identifier} maps over one of its own props to render — detach can't inline data-driven content.`,
    )
  }

  const attrs = callSiteAttributes(opening)
  // A self-closing element (`<Card/>`) HAS no children and IS the whole call
  // site — `.getParent()` on it returns whatever CONTAINS it (a `<div>`, a
  // fragment, …), NOT "this element's own open+close pair". Only a
  // `JsxOpeningElement`'s parent is meaningfully "the JsxElement this call
  // site is". Conflating the two here read a SIBLING element's children as
  // the call site's own, and — worse — replaced the wrong node's text below.
  const isSelfClosing = Node.isJsxSelfClosingElement(opening)
  const jsxElementWrapper = !isSelfClosing ? opening.getParent() : undefined
  const callSiteChildrenText =
    jsxElementWrapper && Node.isJsxElement(jsxElementWrapper)
      ? jsxElementWrapper.getJsxChildren().map((c) => c.getText()).join('')
      : ''

  // Computed BEFORE any import edits below (which insert new lines above the
  // call site and would make a fresh (line, col) lookup stale) — `opening`
  // and `jsxElementWrapper` stay live ts-morph node references across those
  // structural edits (they're a different part of the same tree; only a
  // node whose OWN text is replaced/removed gets "forgotten"), so re-using
  // them here for the actual replacement is what keeps this correct without
  // needing to re-locate by position.
  const inlinedText = buildInlinedJsxText(chosen.expr, childrenParam, paramBindings, attrs, callSiteChildrenText)
  const identifiers = referencedIdentifiers(chosen.expr, new Set(paramBindings.keys()), childrenParam)

  addReconciledImports(sourceFile, target.sourceFile, identifiers)

  // Replace the WHOLE call site (open+children+close, or self-closing) with
  // the inlined text — self-closing replaces ITSELF; open/close replaces the
  // JsxElement WRAPPER (open+children+close), never just the opening tag.
  if (isSelfClosing) {
    opening.replaceWithText(inlinedText)
  } else if (jsxElementWrapper && Node.isJsxElement(jsxElementWrapper)) {
    jsxElementWrapper.replaceWithText(inlinedText)
  } else {
    opening.replaceWithText(inlinedText)
  }

  // Only now — after the call site's own tag reference is actually gone from
  // the tree — is "does anything else in the file still reference Card"
  // decidable.
  removeImportIfLastUsage(sourceFile, identifier)

  sourceFile.saveSync()

  return {
    ok: true,
    ...(hadAlternatives
      ? { branchNote: `${identifier} has more than one rendered state — the currently-shown one was inlined.` }
      : {}),
  }
}
