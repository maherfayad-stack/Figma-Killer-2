/**
 * addSlotPropToComponent — E2.2's second operation: the SAME keep/slot move
 * `extractSubtreeToComponent.ts` performs at promote time, applied to a
 * component that ALREADY EXISTS instead of one being newly created. Replaces
 * a JSX subtree, somewhere inside the component's own render, with
 * `{slotName}`, and adds `slotName` to the component's own props — no new
 * file, no call-site rewrite (there is no ONE call site to rewrite; see
 * below).
 *
 * TWO WAYS THIS GENUINELY DIFFERS FROM `extractSubtreeToComponent`'s SLOTS
 * ----------------------------------------------------------------------------
 *   - **The new prop must be OPTIONAL.** N EXISTING call sites already render
 *     this component without passing it — a REQUIRED prop would stop every
 *     one of them compiling, turning one edit into N broken files (§2's
 *     invariant). `extractSubtreeToComponent`'s slot props are required
 *     because that codemod always rewrites its own single call site to pass
 *     them; this one touches none.
 *   - **No fallback is injected.** The content that WAS inline simply stops
 *     rendering at every call site that doesn't (yet) pass the new prop —
 *     this codemod does not write `{slotName ?? <Original/>}`, because
 *     deciding "does the original markup count as the same as before" is a
 *     SECOND, unrequested inference this module has no business making.
 *     That is exactly why the blast radius must be shown BEFORE committing —
 *     see `params.preview` below, not just an after-the-fact summary.
 *
 * `params.preview` — THE BLAST RADIUS, ENFORCED, NOT JUST DOCUMENTED
 * -----------------------------------------------------------------------
 * Every other codemod in this module's "shown for correction" claims
 * (`extractSubtreeToComponent`'s `freeVariables`, this module's own
 * `callSites`) are honored by CONVENTION — the caller is trusted to have
 * looked before committing, but nothing stops it from skipping straight to
 * the write. That trust is wrong for THIS operation specifically, because
 * the cost of skipping it is silent, invisible content loss at every
 * call site the caller didn't check — not a compile error, not a runtime
 * crash, just markup that quietly stops appearing. So this is enforced
 * structurally instead: `params.preview: true` runs the IDENTICAL
 * validation and mutation pipeline (so a preview that says "OK" is a real
 * guarantee the commit will also succeed, not a weaker approximation of
 * it) against an IN-MEMORY-ONLY `sourceFile`, computes `callSites` the
 * exact same way, and simply never calls `sourceFile.saveSync()` —
 * `committed: false` on the result says so explicitly. The wire-level
 * `add-slot-prop` `StudioEdit` kind (`studioSlotWriteback.ts`) is the
 * caller that actually exercises this: the client is expected to submit
 * `preview: true` first, show `callSites` to the user, and only THEN
 * resubmit with `preview` omitted to commit.
 *
 * **Caveat, stated plainly**: this works because every real caller gets a
 * FRESH `Project` per call (`params.project` omitted, the ordinary case —
 * two separate HTTP requests never share one `Project` instance). Passing
 * the SAME `project` into a preview call and then a later commit call for
 * the SAME target would double-apply the in-memory mutation (e.g. the
 * destructured binding rebuilt twice). Don't do that; there is no
 * production code path that does.
 *
 * WHICH FUNCTION GETS EDITED
 * -----------------------------
 * `params.exportName` names the component directly — `'default'` or a named
 * export, the same field Track E1's `LocalComponentSpec.exportName` already
 * carries (the panel is expected to have that catalog entry in hand before
 * offering this action at all; see this module's own doc for why "use E1's
 * catalog" applies here specifically). `(line, col)` then only has to name
 * WHERE inside that already-identified function's own returned JSX the slot
 * goes — verified, not assumed: a location outside that function's own
 * subtree throws (a caller-contract violation, matching this module's
 * siblings' trust posture for a bad `(file, line, col)`).
 */
import * as path from 'node:path'
import { Node, QuoteKind, type ParameterDeclaration, type Project, type SourceFile } from 'ts-morph'
// `FunctionLike` is this repo's own union (`@core/page-parser`'s barrel), not a
// ts-morph export — it is what `getFunctionLikeNode` returns.
import { createWorkspaceProject, findComponentDeclaration, findNamedComponentDeclaration, getFunctionLikeNode, type FunctionLike } from '@core/page-parser'
import { findJsxElementAtLocationOrThrow, loadSourceFile, resolveJsxWholeElement } from './locateJsxElement'
import { buildParamBindings } from './detachComponent'
import { findComponentCallSites, type ComponentCallSite } from './componentCallSites'

export interface AddSlotPropToComponentParams {
  /** Absolute path to the component's own file. */
  file: string
  /** The component's own export name — `'default'`, or a named export (`LocalComponentSpec.exportName`, Track E1's catalog) — which function in `file` to edit when the file declares more than one. */
  exportName: string
  /** 1-based line/col of the target JSX child's own tag-name start — the subtree, somewhere inside that component's OWN returned JSX, that becomes the slot. Same location convention as every other codemod in this module. */
  line: number
  col: number
  workspaceRoot: string
  /**
   * The new prop's name — `'children'` for the conventional default slot, or
   * a real name. Never invented here — the caller already showed a derived
   * default for correction (mirrors `extractSubtreeToComponent`'s
   * `SlotChildDecision.slotName`; see `subtreeSlotChildren.ts`'s
   * `suggestSlotNames`, the same derivation used at promote time).
   */
  slotName: string
  /**
   * When `true`, runs every check and every in-memory mutation but never
   * calls `sourceFile.saveSync()` — see this module's own doc, "THE BLAST
   * RADIUS, ENFORCED, NOT JUST DOCUMENTED". `committed: false` on the
   * result says the disk was not touched; `callSites` is still the real,
   * live answer.
   */
  preview?: boolean
  project?: Project
}

export type AddSlotPropRefusalReason = 'not-found' | 'no-jsx-parent' | 'unsupported-params' | 'unsupported-props-type' | 'prop-name-taken'

export interface AddSlotPropRefusal {
  reason: AddSlotPropRefusalReason
  message: string
}

export interface AddSlotPropToComponentSuccess {
  ok: true
  slotName: string
  /** Every existing call site of this component — the blast radius, live as of this exact call. See `params.preview`. */
  callSites: ComponentCallSite[]
  /** `false` when `params.preview` was set — nothing reached disk, this was a validation-only dry run. */
  committed: boolean
}

export interface AddSlotPropToComponentFailure {
  ok: false
  refusal: AddSlotPropRefusal
}

export type AddSlotPropToComponentResult = AddSlotPropToComponentSuccess | AddSlotPropToComponentFailure

const SLOT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function refuse(reason: AddSlotPropRefusalReason, message: string): AddSlotPropToComponentFailure {
  return { ok: false, refusal: { reason, message } }
}

/** True when `node` sits entirely within `ancestor`'s own text range. */
function isWithin(node: Node, ancestor: Node): boolean {
  return node.getStart() >= ancestor.getStart() && node.getEnd() <= ancestor.getEnd()
}

function ensureReactNodeImport(sourceFile: SourceFile): void {
  const already = sourceFile
    .getImportDeclarations()
    .some((d) => d.getModuleSpecifierValue() === 'react' && d.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === 'ReactNode'))
  if (already) return
  sourceFile.addImportDeclaration({ moduleSpecifier: 'react', namedImports: ['ReactNode'], isTypeOnly: true })
}

function pascalCaseFromFileBase(base: string): string {
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** `fn`'s own name when it has one (`FunctionDeclaration`), else the file base — an arrow function assigned to a `const` (`getFunctionLikeNode`'s unwrap target) carries no name of its own to recover. */
function deriveComponentTypeName(sourceFile: SourceFile, fn: FunctionLike): string {
  const named = Node.hasName(fn) ? fn.getName() : undefined
  const base = named ?? pascalCaseFromFileBase(sourceFile.getBaseNameWithoutExtension())
  return `${base}Props`
}

type TypeEditOutcome = { ok: true } | { ok: false; reason: 'unsupported-props-type'; message: string }

/**
 * `fn` has NO parameters at all — add one, brand new: a destructured
 * `{ slotName }`, typed against a freshly synthesized `<Name>Props` interface
 * in a TypeScript file, or left untyped in a plain JS one (this module's
 * "honest for JS" posture — no type checker, no guessed type, matching
 * `extractSubtreeToComponent.ts`'s own `unknown`-typed free-variable props).
 */
function addFreshSlotParameter(sourceFile: SourceFile, fn: FunctionLike, slotName: string): TypeEditOutcome {
  const isTypeScriptFile = /\.tsx?$/.test(sourceFile.getFilePath())
  if (!isTypeScriptFile) {
    fn.addParameter({ name: `{ ${slotName} }` })
    return { ok: true }
  }
  const typeName = deriveComponentTypeName(sourceFile, fn)
  ensureReactNodeImport(sourceFile)
  sourceFile.addInterface({ isExported: true, name: typeName, properties: [{ name: slotName, type: 'ReactNode', hasQuestionToken: true }] })
  fn.addParameter({ name: `{ ${slotName} }`, type: typeName })
  return { ok: true }
}

/**
 * `fn` already has a destructured first parameter — add `slotName` to it, and
 * add `slotName?: ReactNode` to whichever type surface it uses: a referenced
 * `interface`/`type` alias, an inline type literal, or (an untyped
 * parameter) none at all, in which case only the binding is added and typing
 * is left alone (same "honest for JS" posture as `addFreshSlotParameter`).
 * Caller has already confirmed `first`'s name node is an `ObjectBindingPattern`
 * (`buildParamBindings`'s `hasUndestructuredParam` check, asked before this
 * runs) — see this module's own `addSlotPropToComponent`.
 */
function addSlotToExistingPattern(sourceFile: SourceFile, first: ParameterDeclaration, slotName: string): TypeEditOutcome {
  const pattern = first.getNameNode()
  if (Node.isObjectBindingPattern(pattern)) {
    // `ObjectBindingPattern` has no structural "add an element" API (unlike
    // `InterfaceDeclaration`/`TypeLiteralNode`'s `addProperty`) — rebuild the
    // pattern's own text instead, keeping every existing element's own text
    // VERBATIM (a rename, a default, a `...rest` — untouched) and appending
    // the new plain identifier last.
    const elementTexts = [...pattern.getElements().map((el) => el.getText()), slotName]
    pattern.replaceWithText(`{ ${elementTexts.join(', ')} }`)
  }

  const typeNode = first.getTypeNode()
  if (!typeNode) return { ok: true } // untyped — nothing to annotate

  ensureReactNodeImport(sourceFile)

  if (Node.isTypeLiteral(typeNode)) {
    typeNode.addProperty({ name: slotName, type: 'ReactNode', hasQuestionToken: true })
    return { ok: true }
  }
  if (Node.isTypeReference(typeNode)) {
    const typeName = typeNode.getTypeName().getText()
    const iface = sourceFile.getInterface(typeName)
    if (iface) {
      iface.addProperty({ name: slotName, type: 'ReactNode', hasQuestionToken: true })
      return { ok: true }
    }
    const alias = sourceFile.getTypeAlias(typeName)
    const aliasType = alias?.getTypeNode()
    if (alias && aliasType && Node.isTypeLiteral(aliasType)) {
      aliasType.addProperty({ name: slotName, type: 'ReactNode', hasQuestionToken: true })
      return { ok: true }
    }
    return {
      ok: false,
      reason: 'unsupported-props-type',
      message: `Could not find "${typeName}"'s own declaration in this file to add a "${slotName}" property to.`,
    }
  }
  return { ok: false, reason: 'unsupported-props-type', message: "This component's props type is not a plain object shape Studio can add a property to." }
}

/** Adds `slotName` to `fn`'s own signature — a fresh parameter when it has none, or a new binding/property on its existing destructured one. */
function addSlotToSignature(sourceFile: SourceFile, fn: FunctionLike, slotName: string): TypeEditOutcome {
  const first = fn.getParameters()[0]
  if (!first) return addFreshSlotParameter(sourceFile, fn, slotName)
  return addSlotToExistingPattern(sourceFile, first, slotName)
}

export function addSlotPropToComponent(params: AddSlotPropToComponentParams): AddSlotPropToComponentResult {
  const { file, exportName, line, col, workspaceRoot, slotName } = params
  if (!SLOT_NAME_RE.test(slotName)) {
    // Caller-contract violation — the picker UI is responsible for only ever
    // sending a valid identifier (already shown for correction via
    // `subtreeSlotChildren.ts`'s `suggestSlotNames`), same trust level
    // `extractSubtreeToComponent.ts`'s `componentName` format check extends.
    throw new Error(`addSlotPropToComponent: "${slotName}" is not a valid prop name.`)
  }

  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const sourceFile = loadSourceFile(project, file)

  const declaration = exportName === 'default' ? findComponentDeclaration(sourceFile) : findNamedComponentDeclaration(sourceFile, exportName, true)
  const fn = declaration ? getFunctionLikeNode(declaration) : undefined
  if (!fn) {
    return refuse(
      'not-found',
      `Could not find an exported component named "${exportName}" in ${path.basename(file)} any more — the file changed since this was last read. Reload and try again.`,
    )
  }

  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const { root } = resolveJsxWholeElement(opening)
  if (!isWithin(root, fn)) {
    throw new Error(`addSlotPropToComponent: the element at ${file}:${line}:${col} is not part of "${exportName}"'s own returned JSX.`)
  }

  const parent = root.getParent()
  if (!parent || !(Node.isJsxElement(parent) || Node.isJsxFragment(parent))) {
    return refuse(
      'no-jsx-parent',
      "This element is the component's entire returned markup — there is nothing to insert a slot reference alongside. Pick a child element instead.",
    )
  }

  const { childrenParam, params: existingParams, hasUndestructuredParam } = buildParamBindings(fn)
  if (hasUndestructuredParam) {
    return refuse(
      'unsupported-params',
      `"${exportName}" takes an undestructured props parameter — Studio can't add a named slot without rewriting every existing "props.x" reference.`,
    )
  }

  const existingAttrNames = new Set([...existingParams.values()].map((b) => b.attrName))
  const existingParamNames = new Set(existingParams.keys())
  if (childrenParam) {
    existingAttrNames.add('children')
    existingParamNames.add(childrenParam)
  }
  if (existingAttrNames.has(slotName) || existingParamNames.has(slotName)) {
    return refuse('prop-name-taken', `"${exportName}" already has a "${slotName}" prop.`)
  }

  const typeResult = addSlotToSignature(sourceFile, fn, slotName)
  if (!typeResult.ok) return refuse(typeResult.reason, typeResult.message)

  root.replaceWithText(`{${slotName}}`)
  const callSites = findComponentCallSites(project, workspaceRoot, file, exportName)
  // The one line that decides whether anything reaches disk — see
  // `params.preview`'s own doc for why everything ABOVE this line still
  // ran in full even for a preview.
  if (!params.preview) sourceFile.saveSync()

  return { ok: true, slotName, callSites, committed: !params.preview }
}
