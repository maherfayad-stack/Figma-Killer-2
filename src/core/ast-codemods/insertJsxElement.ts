/**
 * insertJsxElement — the write behind "add a design-system component to the
 * canvas" on a studio-imported board. Writes a new JSX child into a parent
 * element in the user's source, together with the `import` that names it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `struct-01` shipped `move` and `delete` and left `insert` as a blanket
 * refusal — a new node minted on the canvas carries a nanoid id, which can
 * never be written back, so accepting the gesture would have recreated the
 * silent no-op it had just removed. The missing half is exactly this codemod:
 * the editor does not mint a node at all, it asks the SOURCE to grow one and
 * then re-reads the file. The element the user sees afterwards is a real
 * parsed node with a real `rel:line:col` id, editable like any other, because
 * it came back through the same parse as everything else on the board.
 *
 * TWO WRITES, ONE TARGET
 * ----------------------
 * An insert touches two places in the file: the JSX child, and the import that
 * binds its tag name. That is not a violation of "exactly one honest target" —
 * they are two halves of one indivisible statement (a `<Button/>` with no
 * `Button` in scope is not valid code), and both are computed and spliced in
 * the same pass so the file is never left in the half-written state. What the
 * codemod refuses to do is guess: if the name is ALREADY bound in this file to
 * something that is not this import, it refuses (`binding-conflict`) rather
 * than shadowing the user's own symbol.
 *
 * COMPONENTS AND INTRINSIC TAGS
 * -----------------------------
 * `importSpecifier` is what distinguishes the two things this codemod can
 * write, and the distinction is JSX's own: React reads `<div>` as the string
 * `"div"` and `<Button>` as the in-scope identifier `Button`.
 *
 *   - **With** an `importSpecifier`, `name` is a COMPONENT — the import above
 *     is written, and the binding-conflict check applies.
 *   - **Without** one, `name` is an INTRINSIC tag (`div`, `span`, `button`).
 *     There is nothing to import and no binding to conflict with, so both of
 *     those steps are skipped.
 *
 * The intrinsic path is not a convenience: without it there was no way to
 * write a layout element at all, so an agent composing a screen could add
 * design-system components but not the `<div>`s that arrange them — it could
 * create a page and then not build anything in it. The name is validated
 * (`isSafeIntrinsicTagName`) rather than trusted, because "no import" would
 * otherwise make a MISSPELLED component name (`<Buton />`) look like a
 * perfectly legal unknown element instead of the error it is, and because a
 * tag written into source runs the moment the user starts their dev server —
 * Studio's "parse, never execute" invariant protects the canvas from what it
 * READS, not the user's project from what Studio WRITES.
 *
 * BYTE-EXACTNESS, same standard as `moveJsxElement`/`deleteJsxElement`. The
 * AST only LOCATES; the write is a splice into the original bytes
 * (`jsxChildRange.ts`). Indentation is COPIED from a sibling wherever one
 * exists rather than assumed, so a file indented with tabs or four spaces
 * keeps its own style and no unrelated line is reformatted.
 *
 * WHERE the child goes is `jsxChildPlacement.ts` (W4-1) and the `import` it
 * needs is `jsxImportEdits.ts` — both were this module's private helpers until
 * `moveJsxElement`'s cross-parent form and `wrapJsxElement` needed the same two
 * answers. A reparent lands with exactly the whitespace an insert at the same
 * spot would have produced, because it is the same function.
 */
import { Project } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import { applyTextEdits, verbatimSourceText, writeVerbatimSource } from './jsxChildRange'
import { resolveChildPlacement } from './jsxChildPlacement'
import { conflictingBinding, resolveImportEdits } from './jsxImportEdits'
import {
  collectSubtreeImports,
  indentBlock,
  refuse,
  renderJsxNode,
  validateSubtree,
  type InsertJsxChildren,
  type InsertJsxRefusal,
  type InsertableJsxPropValue,
} from './jsxSubtree'

export interface InsertJsxElementParams {
  file: string
  /** 1-based line/col of the PARENT element the child is added to (its tag-name start). */
  line: number
  col: number
  /** 1-based line/col of the sibling the new element is written against. Omit to append as the last child. */
  anchorLine?: number
  anchorCol?: number
  /** Which side of the anchor the new element lands on. Ignored without an anchor. */
  position?: 'before' | 'after'
  /** Tag name of the new element — a component (`Button`) with an `importSpecifier`, an intrinsic tag (`div`) without one. */
  name: string
  /** Props written onto the new element. Entries whose value is `undefined` are skipped. */
  props?: Record<string, InsertableJsxPropValue | undefined>
  /**
   * Module the tag name is imported from, e.g. `@alm-design/design-system`.
   * Omit to write an intrinsic HTML tag, which needs no import.
   */
  importSpecifier?: string
  /**
   * The new element's content — literal text (`<span>Sign in</span>`), or a
   * nested subtree written in the SAME call. Omit for an empty element.
   *
   * ## Why a whole subtree, and not one element per call
   *
   * An insert changes the file's line count, which invalidates every node id
   * decoded before it. Composing a screen one element per call therefore costs
   * a re-parse per element, and a ~30-node mobile screen becomes ~30 sequential
   * round trips — measured at over twenty minutes for a single screen, which is
   * what made "build five screens" not merely slow but impractical.
   *
   * Rendering the whole subtree into one splice removes the dependency
   * entirely: no intermediate node needs an id, because nothing reads one
   * between the levels. One call, one write, one re-parse.
   *
   * An expression child (`{count}`) is still not expressible — it would need a
   * scope this codemod cannot verify — and text is refused on a void element.
   */
  children?: InsertJsxChildren
  /** Optional pre-existing project to reuse. */
  project?: Project
}

export type InsertJsxElementResult = { ok: true } | { ok: false; refusal: InsertJsxRefusal }

export function insertJsxElement(params: InsertJsxElementParams): InsertJsxElementResult {
  const { file, line, col, name, importSpecifier, children } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  // Validated for the WHOLE subtree before a single byte is written — a
  // refusal three levels down must leave the file untouched, not half-built.
  const invalid = validateSubtree({ name, props: params.props, importSpecifier, children })
  if (invalid) return invalid

  const parentOpening = findJsxElementAtLocation(sourceFile, line, col)
  if (!parentOpening) {
    return refuse(
      'not-found',
      `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  // Only a component name can collide: an intrinsic tag is a string to JSX,
  // never a reference to a binding, so a local `const div = …` is irrelevant
  // to `<div />` and refusing on it would be a false positive. Checked for
  // every component in the subtree, not just the root.
  const imports = collectSubtreeImports({ name, props: params.props, importSpecifier, children })
  for (const [componentName, specifier] of imports) {
    const binding = conflictingBinding(sourceFile, componentName, specifier)
    if (binding) {
      return refuse(
        'binding-conflict',
        `This file already uses the name "${componentName}" for something else (${binding}), so adding the component here would shadow it. Rename one of them in the file first.`,
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

  const placement = resolveChildPlacement(
    sourceFile,
    verbatim,
    parentOpening,
    {
      anchor:
        params.anchorLine !== undefined && params.anchorCol !== undefined
          ? { line: params.anchorLine, col: params.anchorCol }
          : null,
      ...(params.position ? { position: params.position } : {}),
    },
    (indent, unit) => indentBlock(renderJsxNode({ name, props: params.props, importSpecifier, children }, unit), indent),
  )
  if (!placement.ok) return placement

  const importEdits = resolveImportEdits(sourceFile, verbatim, imports)

  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [placement.edit, ...importEdits]))
  return { ok: true }
}
