/**
 * extractComponentCopy — WS-4.4's escape hatch for a `detachComponentInstance`
 * refusal. When a component genuinely cannot be inlined (it uses hooks, maps
 * over a prop, …), detach is a dead end but this isn't: duplicate the
 * component's own file under a fresh name (`Card.tsx` -> `Card2.tsx`), rename
 * its export to match, and repoint THIS ONE call site at the copy. The user
 * now has an independent component they can edit (including, later, editing
 * ITS call-site props, or eventually detaching IT if its body allows) without
 * touching the original component's other call sites at all.
 *
 * Deliberately much simpler than `swapComponentInstance`: the new component
 * is a byte-for-byte copy (same props, same body), so there is no prop set to
 * diff — only the export/file identity changes.
 */
import * as path from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Node, Project, QuoteKind, type SourceFile } from 'ts-morph'
import { createWorkspaceProject } from '@core/page-parser'
import { findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { resolveComponentCallSite } from './resolveComponentCallSite'

export interface ExtractComponentCopyParams {
  /** Absolute path to the page file holding the call site to repoint. */
  file: string
  line: number
  col: number
  workspaceRoot: string
  project?: Project
}

export type ExtractComponentCopyRefusalReason = 'not-a-component' | 'unresolvable' | 'copy-exists'

export interface ExtractComponentCopyRefusal {
  reason: ExtractComponentCopyRefusalReason
  message: string
}

export interface ExtractComponentCopySuccess {
  ok: true
  /** Workspace-relative POSIX path of the new file. */
  newFile: string
  /** The new file's export name (and the call site's new JSX tag name). */
  newComponentName: string
}

export interface ExtractComponentCopyFailure {
  ok: false
  refusal: ExtractComponentCopyRefusal
}

export type ExtractComponentCopyResult = ExtractComponentCopySuccess | ExtractComponentCopyFailure

function refuse(reason: ExtractComponentCopyRefusalReason, message: string): ExtractComponentCopyFailure {
  return { ok: false, refusal: { reason, message } }
}

/** `Card` -> `Card2`, `Card9` -> `Card10`, … — the first name with no existing sibling file or in-scope binding. */
function nextAvailableName(baseName: string, isTaken: (candidate: string) => boolean): string {
  let n = 2
  while (isTaken(`${baseName}${n}`)) n += 1
  return `${baseName}${n}`
}

export function extractComponentCopy(params: ExtractComponentCopyParams): ExtractComponentCopyResult {
  const { file, line, col, workspaceRoot } = params
  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  // See `detachComponent.ts`'s identical setting for why: new import
  // declarations are synthesized, not text-matched, so they follow this
  // setting rather than the file's existing quote style.
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const sourceFile = loadSourceFile(project, file)

  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const fullTagName = opening.getTagNameNode().getText()
  const identifier = fullTagName.split('.')[0]!
  if (!/^[A-Z]/.test(fullTagName)) {
    return refuse('not-a-component', `<${fullTagName}> is a plain HTML element, not a component instance.`)
  }

  const resolved = resolveComponentCallSite(project, sourceFile, workspaceRoot, identifier, file, line, col)
  if (!resolved.ok) return refuse('unresolvable', resolved.failure.message)
  const { target } = resolved.result

  const targetPath = target.sourceFile.getFilePath()
  const dir = path.dirname(targetPath)
  const ext = path.extname(targetPath)
  const baseName = path.basename(targetPath, ext)

  const newName = nextAvailableName(baseName, (candidate) => existsSync(path.join(dir, `${candidate}${ext}`)))
  const newPath = path.join(dir, `${newName}${ext}`)
  if (existsSync(newPath)) return refuse('copy-exists', `${newName}${ext} already exists next to ${baseName}${ext}.`)

  // Copy the file text, then rename the export (function/const declaration
  // name, and its `export default`/named export form) inside the COPY only —
  // the original file and every other call site are untouched.
  const originalText = readFileSync(targetPath, 'utf8')
  writeFileSync(newPath, originalText, 'utf8')

  const copyProject = new Project({
    useInMemoryFileSystem: false,
    compilerOptions: { allowJs: true },
    manipulationSettings: { quoteKind: QuoteKind.Single },
  })
  const copySourceFile = copyProject.addSourceFileAtPath(newPath)
  renameDeclaration(copySourceFile, target.exportedName ?? baseName, newName)
  copySourceFile.saveSync()

  // Repoint THIS ONE call site: rename the JSX tag, and point its import (or
  // add a fresh one) at the new file instead of the original.
  const relSpecifier = importSpecifierFor(file, newPath)
  retagCallSite(opening, newName)
  repointImport(sourceFile, identifier, newName, relSpecifier)
  sourceFile.saveSync()

  const newFileRel = path.relative(workspaceRoot, newPath).split(path.sep).join('/')
  return { ok: true, newFile: newFileRel, newComponentName: newName }
}

function renameDeclaration(sourceFile: SourceFile, oldName: string, newName: string): void {
  const fn = sourceFile.getFunction(oldName)
  if (fn) {
    fn.rename(newName)
    return
  }
  const variable = sourceFile.getVariableDeclaration(oldName)
  if (variable) {
    variable.rename(newName)
  }
}

function importSpecifierFor(fromFileAbs: string, toFileAbs: string): string {
  const fromDir = path.dirname(fromFileAbs)
  let rel = path.relative(fromDir, toFileAbs).split(path.sep).join('/')
  rel = rel.replace(/\.(tsx|jsx|ts|js)$/, '')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

/** Same self-closing-vs-opening distinction as `swapComponentInstance.ts` — see its identical comment for why `.getParent()` is only meaningful when `opening` is a `JsxOpeningElement`. */
function retagCallSite(opening: ReturnType<typeof findJsxElementAtLocationOrThrow>, newName: string): void {
  opening.getTagNameNode().replaceWithText(newName)
  if (!Node.isJsxOpeningElement(opening)) return
  const parent = opening.getParent()
  if (Node.isJsxElement(parent)) {
    parent.getClosingElement().getTagNameNode().replaceWithText(newName)
  }
}

/** Adds an import for `newName` from `specifier`, and drops `oldName`'s import if nothing else in the page file still references it. Mirrors `swapComponentInstance.ts`'s identical need — kept local here since this codemod predates it in the write order and the two refusal/edge-case shapes differ slightly (this one never needs a prop diff). */
function repointImport(sourceFile: SourceFile, oldName: string, newName: string, specifier: string): void {
  sourceFile.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [newName] })

  const stillUsed = sourceFile.getDescendants().some((node) => {
    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node) || Node.isJsxClosingElement(node)) {
      return node.getTagNameNode().getText().split('.')[0] === oldName
    }
    return false
  })
  if (stillUsed) return

  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getDefaultImport()?.getText() === oldName) {
      if (decl.getNamedImports().length === 0 && !decl.getNamespaceImport()) decl.remove()
      return
    }
    const named = decl.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getNameNode().getText()) === oldName)
    if (named) {
      if (decl.getNamedImports().length === 1 && !decl.getDefaultImport() && !decl.getNamespaceImport()) decl.remove()
      else named.remove()
      return
    }
  }
}
