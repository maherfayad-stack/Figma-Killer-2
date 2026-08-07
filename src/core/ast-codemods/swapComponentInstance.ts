/**
 * swapComponentInstance — WS-4.5, the Figma "swap instance" verb. Renames a
 * component call site's JSX tag to a DIFFERENT component (`<Card/>` ->
 * `<Tile/>`), adds/repoints the import, and diffs the prop sets: a prop the
 * new component doesn't accept is removed and reported; a prop the new
 * component requires (a destructured param with no default) that the old
 * component didn't have is left for the user to fill in and reported as
 * `unfilledRequiredProps` rather than guessed at.
 *
 * This lifts `setJsxTagName`'s explicit refusal of a component reference —
 * that codemod's stated reason ("would need the new name imported and in
 * scope") is precisely what this one does.
 */
import * as path from 'node:path'
import { Node, Project, QuoteKind, type SourceFile } from 'ts-morph'
import { createWorkspaceProject, getFunctionLikeNode, resolveExportedDeclaration } from '@core/page-parser'
import { findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { buildParamBindings } from './detachComponent'
import { relativeSpecifier, removeImportIfLastUsage, topLevelBindingNames } from './importReconcile'

export interface SwapComponentInstanceParams {
  /** Absolute path to the page file holding the call site. */
  file: string
  line: number
  col: number
  workspaceRoot: string
  /** The component to swap IN — its display/export name (and new JSX tag name). */
  newComponentName: string
  newComponentSource: 'local' | 'package'
  /** Workspace-relative POSIX path for a local component, or the bare package specifier for a package export. */
  newComponentFile: string
  project?: Project
}

export type SwapRefusalReason = 'not-a-component' | 'unresolvable' | 'name-shadow' | 'same-component'

export interface SwapRefusal {
  reason: SwapRefusalReason
  message: string
}

export interface SwapSuccess {
  ok: true
  /** Call-site props the new component doesn't accept — removed from the JSX. */
  removedProps: string[]
  /** Required props (no destructured default) the new component declares that the call site does not supply — NOT synthesized, left for the user to fill in. */
  unfilledRequiredProps: string[]
}

export interface SwapFailure {
  ok: false
  refusal: SwapRefusal
}

export type SwapResult = SwapSuccess | SwapFailure

function refuse(reason: SwapRefusalReason, message: string): SwapFailure {
  return { ok: false, refusal: { reason, message } }
}

/**
 * Best-effort read of the NEW component's own declared prop names, so the
 * call site's prop set can be diffed against it. Resolves a LOCAL target via
 * ts-morph the same way `detachComponent`/`inlineLocalComponents` do; a
 * PACKAGE target resolves only when its own entry file is a `.ts(x)` this
 * `Project` can parse (a hand-authored source package, or one shipping a
 * readable `.d.ts` already added to the project) — anything else (a
 * compiled bundle with no declarations) returns `undefined`, and the caller
 * skips diffing rather than guessing. `undefined` is a genuinely different
 * outcome from "the component takes no props" (an empty `Set`), which is
 * why this returns `Map | undefined`, not `Map`.
 */
function resolveNewComponentParams(
  project: Project,
  workspaceRoot: string,
  newComponentSource: 'local' | 'package',
  newComponentFile: string,
  newComponentName: string,
): ReturnType<typeof buildParamBindings> | undefined {
  let targetSourceFile: SourceFile | undefined
  if (newComponentSource === 'local') {
    const abs = path.resolve(workspaceRoot, newComponentFile)
    targetSourceFile = project.getSourceFile(abs) ?? tryAddSourceFile(project, abs)
  } else {
    // A bare package specifier has no direct file path this module can
    // resolve without going through the workspace's own module resolution
    // (tsconfig `paths`, `node_modules` lookup) — out of scope for this
    // best-effort read; package prop-diffing is a documented gap.
    return undefined
  }
  if (!targetSourceFile) return undefined

  const declaration = findNamedOrDefaultDeclaration(targetSourceFile, newComponentName)
  if (!declaration) return undefined
  const fn = getFunctionLikeNode(declaration)
  if (!fn) return undefined
  return buildParamBindings(fn)
}

function tryAddSourceFile(project: Project, abs: string): SourceFile | undefined {
  try {
    return project.addSourceFileAtPath(abs)
  } catch {
    return undefined
  }
}

/** Direct declaration by name, or the same name resolved through a re-exporting barrel — never a fallback guess at some OTHER export, which could misattribute a prop diff to the wrong component. */
function findNamedOrDefaultDeclaration(sourceFile: SourceFile, name: string) {
  const direct = sourceFile.getFunction(name) ?? sourceFile.getVariableDeclaration(name)
  if (direct) return direct
  const declaring = resolveExportedDeclaration(sourceFile, name)
  if (declaring) {
    return declaring.sourceFile.getFunction(declaring.name) ?? declaring.sourceFile.getVariableDeclaration(declaring.name)
  }
  return undefined
}

/**
 * Swaps the component instance at (file, line, col) for `newComponentName`.
 * Refuses (never guesses) when the new name would shadow an existing
 * binding, or when the target location isn't a component call site at all.
 */
export function swapComponentInstance(params: SwapComponentInstanceParams): SwapResult {
  const { file, line, col, workspaceRoot, newComponentName, newComponentSource, newComponentFile } = params
  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  // See `detachComponent.ts`'s identical setting for why.
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const sourceFile = loadSourceFile(project, file)

  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const fullTagName = opening.getTagNameNode().getText()
  const identifier = fullTagName.split('.')[0]!
  if (!/^[A-Z]/.test(fullTagName)) {
    return refuse('not-a-component', `<${fullTagName}> is a plain HTML element, not a component instance.`)
  }
  if (identifier === newComponentName) {
    return refuse('same-component', `Already an instance of ${newComponentName}.`)
  }

  const existingNames = topLevelBindingNames(sourceFile)
  // Shadowing is only a real conflict against a DIFFERENT binding — the
  // identifier being swapped OUT is about to be removed (if unused
  // elsewhere), so it doesn't count against itself.
  if (existingNames.has(newComponentName) && newComponentName !== identifier) {
    return refuse(
      'name-shadow',
      `"${newComponentName}" is already used by another import/declaration in this file — rename it first, or pick a different component.`,
    )
  }

  // Prop diff — computed BEFORE any edits, against the ORIGINAL call site's
  // own attribute set.
  const callSiteAttrNames = new Set(
    opening.getAttributes().filter(Node.isJsxAttribute).map((a) => a.getNameNode().getText()),
  )
  const newParams = resolveNewComponentParams(project, workspaceRoot, newComponentSource, newComponentFile, newComponentName)
  const removedProps: string[] = []
  const unfilledRequiredProps: string[] = []
  if (newParams) {
    const acceptedNames = new Set([...newParams.params.values()].map((b) => b.attrName))
    for (const attr of callSiteAttrNames) {
      if (!acceptedNames.has(attr) && attr !== 'key' && attr !== 'ref') removedProps.push(attr)
    }
    for (const binding of newParams.params.values()) {
      const required = binding.defaultText === undefined
      if (required && !callSiteAttrNames.has(binding.attrName)) unfilledRequiredProps.push(binding.attrName)
    }
  }

  // Rename the tag (opening + closing, or self-closing). A self-closing
  // element's `.getParent()` is whatever CONTAINS it (e.g. a `<div>` this
  // instance sits inside), not "this element's own open+close pair" — only
  // check `.getParent()` when `opening` is a `JsxOpeningElement`. Get this
  // wrong and a swapped instance nested inside another element renames the
  // CONTAINING element's closing tag instead (mismatched tags, broken JSX).
  opening.getTagNameNode().replaceWithText(newComponentName)
  if (Node.isJsxOpeningElement(opening)) {
    const parent = opening.getParent()
    if (Node.isJsxElement(parent)) {
      parent.getClosingElement().getTagNameNode().replaceWithText(newComponentName)
    }
  }

  // Remove call-site attributes the new component doesn't accept.
  for (const attr of opening.getAttributes()) {
    if (!Node.isJsxAttribute(attr)) continue
    const name = attr.getNameNode().getText()
    if (removedProps.includes(name)) attr.remove()
  }

  // Add/repoint the import.
  const specifier = newComponentSource === 'local'
    ? relativeSpecifier(file, path.resolve(workspaceRoot, newComponentFile))
    : newComponentFile
  sourceFile.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [newComponentName] })
  if (identifier !== newComponentName) removeImportIfLastUsage(sourceFile, identifier)

  sourceFile.saveSync()

  return { ok: true, removedProps, unfilledRequiredProps }
}
