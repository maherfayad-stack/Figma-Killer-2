/**
 * wrapJsxElement — W4-1, the write behind "wrap this in a container" on a
 * studio-imported board. Replaces the JSX child at a `line:col` with
 * `<div>…that same element…</div>`, and writes the `import` when the wrapper is
 * a component rather than an intrinsic tag.
 *
 * "NO WRAPPER DIVS" IS A CANVAS RULE, NOT A SOURCE RULE
 * ----------------------------------------------------
 * Studio's standing prohibition — the one behind `studio.instance` rendering as
 * a bare Fragment (zero DOM elements) — is about the CANVAS inventing DOM the
 * user's source does not contain: a wrapper that exists only in the renderer
 * breaks percentage/flex height chains and `>`/`+` combinators that cross it,
 * and nothing in the repository explains why. A wrapper written INTO the source
 * is the opposite thing. After this codemod the `<div>` is in the file, the
 * user can read it, style it, delete it, and every subsequent parse sees it as
 * an ordinary element with its own `rel:line:col`. That is a real element the
 * user asked for, not a rendering artefact — which is why the refusal this
 * lifts (`sourceStructure.ts`'s `wrap`) was about the missing SOURCE POSITION
 * all along, and is answered by writing one.
 *
 * THE ONE PLACE A STRUCTURAL CODEMOD REINDENTS
 * --------------------------------------------
 * The wrapped subtree gains one indentation level (`reindentBlock`). Every
 * other structural codemod here leaves untouched bytes alone to the character,
 * and this one still does for every line outside the wrapped element — but the
 * subtree itself now sits one level deeper, and leaving its inner lines at
 * their old column would produce code nobody would write by hand. Only leading
 * whitespace changes; comments, attribute wrapping and blank lines inside the
 * subtree survive verbatim.
 *
 * An element that shares its line with a sibling (`<div><a/><b/></div>`) is
 * wrapped in place, on that line, with no reindentation at all.
 */
import { type Project } from 'ts-morph'
import { createProject, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
} from './jsxChildRange'
import { indentUnit, lineIndentAt, reindentBlock } from './jsxChildPlacement'
import { conflictingBinding, resolveImportEdits } from './jsxImportEdits'
import { refuse, validateSubtree, type InsertJsxRefusal } from './jsxSubtree'

export interface WrapJsxElementParams {
  file: string
  /** 1-based line/col of the element being wrapped (its tag-name start). */
  line: number
  col: number
  /**
   * Tag name of the wrapper — an intrinsic element (`div`, `section`) with no
   * `importSpecifier`, a component (`Stack`) with one. The same distinction
   * `insertJsxElement` draws, for the same reason: JSX reads `<div>` as the
   * string `"div"` and `<Stack>` as the in-scope identifier `Stack`.
   */
  name: string
  /** Module the wrapper is imported from. Omit for an intrinsic tag, which needs no import. */
  importSpecifier?: string
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type WrapJsxElementResult = { ok: true } | { ok: false; refusal: InsertJsxRefusal }

export function wrapJsxElement(params: WrapJsxElementParams): WrapJsxElementResult {
  const { file, line, col, name, importSpecifier } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  // The wrapper is one element with no children of its own to validate (the
  // children ARE the subtree already in the file), but it gets the identical
  // tag-safety gate every written tag goes through — a wrapper is source that
  // runs the moment the user starts their dev server.
  const invalid = validateSubtree({ name, ...(importSpecifier === undefined ? {} : { importSpecifier }) })
  if (invalid) return invalid

  const target = resolveJsxChildRange(sourceFile, line, col)
  if (!target.ok) return refuse(target.reason, target.message)

  if (importSpecifier !== undefined) {
    const binding = conflictingBinding(sourceFile, name, importSpecifier)
    if (binding) {
      return refuse(
        'binding-conflict',
        `This file already uses the name "${name}" for something else (${binding}), so wrapping with that component here would shadow it. Rename one of them in the file first.`,
      )
    }
  }

  const verbatim = verbatimSourceText(sourceFile, file)
  if (verbatim === null) {
    return refuse(
      'stale-source',
      'This file changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  // The ELEMENT's own bytes, not the owned range: the range includes the
  // indentation and newline that stay exactly where they are — what moves
  // inside the wrapper is the element itself.
  const elementStart = target.range.element.getStart()
  const elementEnd = target.range.element.getEnd()
  const subtree = verbatim.slice(elementStart, elementEnd)
  const baseIndent = lineIndentAt(verbatim, elementStart)
  const unit = indentUnit(verbatim)

  const wrapped = target.range.wholeLine
    ? [
        `<${name}>`,
        `${baseIndent}${unit}${reindentBlock(subtree, baseIndent, baseIndent + unit)}`,
        `${baseIndent}</${name}>`,
      ].join('\n')
    : `<${name}>${subtree}</${name}>`

  const importEdits = resolveImportEdits(
    sourceFile,
    verbatim,
    importSpecifier === undefined ? new Map() : new Map([[name, importSpecifier]]),
  )

  writeVerbatimSource(
    sourceFile,
    file,
    applyTextEdits(verbatim, [{ start: elementStart, end: elementEnd, text: wrapped }, ...importEdits]),
  )
  return { ok: true }
}
