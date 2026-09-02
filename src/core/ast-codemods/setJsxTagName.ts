/**
 * Renames the HTML element at a source location — `<div>…</div>` → `<section>…
 * </section>` — then writes the change back to disk.
 *
 * The editor exposes an element's tag as an ordinary property (`base.container`'s
 * `tag` select, `base.text`'s), but unlike every other property it is NOT an
 * attribute: `parsedPageToSitePage` synthesizes it from the element's NAME so an
 * imported `<h1>` keeps rendering as an `<h1>` instead of a module's default
 * `<div>`. Routing it through `setJsxProp` therefore did the wrong thing quietly
 * — it added a literal `tag="section"` attribute to the source, which React
 * passes through to the DOM as an unknown attribute while the element stayed a
 * `<div>`. On one imported app that was 140 properties' worth of controls that
 * looked live, changed the canvas, and wrote junk to the user's file.
 *
 * FAILS CLOSED, on three rules:
 *
 *  - The target must be a lowercase HTML element. Renaming a COMPONENT reference
 *    (`<Sheet>` → `<Dialog>`) is a different operation: the new name has to be
 *    imported and in scope, and this codemod has no way to know that.
 *  - The new name must be a plain HTML tag name. Anything else could inject
 *    arbitrary text into the tag position.
 *  - A JsxElement's closing tag is renamed with its opening tag, in one edit, so
 *    the file is never left with mismatched tags.
 */
import { Node, Project } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'

export interface SetJsxTagNameParams {
  file: string
  line: number
  col: number
  /** The new tag name, e.g. `'section'`. */
  tag: string
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/** Thrown when the element at the target location cannot be renamed. `path` is `<file>:<line>:<col>`. */
export class JsxTagNameTargetError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(`[ast-codemods/setJsxTagName] ${path}: ${message}`)
    this.name = 'JsxTagNameTargetError'
    this.path = path
  }
}

/**
 * A plain HTML tag name: a letter, then letters/digits/hyphens (which also covers
 * custom elements like `my-widget`). Deliberately excludes `.` and `:`, so a
 * member expression (`<Foo.Bar>`) or a namespaced name can never be written here.
 */
const HTML_TAG_NAME = /^[a-z][a-z0-9-]*$/

export function setJsxTagName(params: SetJsxTagNameParams): void {
  const { file, line, col, tag } = params
  const path = `${file}:${line}:${col}`

  if (!HTML_TAG_NAME.test(tag)) {
    throw new JsxTagNameTargetError(`"${tag}" is not a plain HTML tag name`, path)
  }

  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const opening = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)

  const currentName = opening.getTagNameNode().getText()
  if (!HTML_TAG_NAME.test(currentName)) {
    throw new JsxTagNameTargetError(
      `<${currentName}> is a component, not an HTML element — renaming it would need an import`,
      path,
    )
  }
  if (currentName === tag) return

  // A self-closing element has no closing tag; a JsxElement has exactly one, and
  // both names must move together.
  const parent = opening.getParent()
  if (Node.isJsxElement(parent)) {
    parent.getClosingElement().getTagNameNode().replaceWithText(tag)
  }
  opening.getTagNameNode().replaceWithText(tag)

  sourceFile.saveSync()
}
