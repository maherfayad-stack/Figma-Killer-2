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
 * the same pass so the file is never left in the half-written state. It never
 * shadows the user's own symbol: if the name is ALREADY bound in this file to
 * something that is not this import, the component is imported under an alias
 * (`{ Button as Button2 }`, P3-C WB-19 — `planImportBindings`) and written
 * as `<Button2 />`. That used to refuse `binding-conflict`; the name is only a
 * spelling, and the alias renders the same component.
 *
 * COMPONENTS AND INTRINSIC TAGS
 * -----------------------------
 * `importSpecifier` is what distinguishes the two things this codemod can
 * write, and the distinction is JSX's own: React reads `<div>` as the string
 * `"div"` and `<Button>` as the in-scope identifier `Button`.
 *
 *   - **With** an `importSpecifier`, `name` is a COMPONENT — the import above
 *     is written, under an alias when the name is taken.
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
import { Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import { applyTextEdits, verbatimSourceText, writeVerbatimSource } from './jsxChildRange'
import {
  createdJsxLocation,
  createdJsxLocationsIn,
  offsetAfterEdits,
  type CreatedJsxLocation,
} from './createdJsxLocation'
import { resolveChildPlacement } from './jsxChildPlacement'
import { planImportBindings, resolveImportEdits, type ImportRequirement } from './jsxImportEdits'
import { bindAssetImports, collectAssetImports } from './jsxAssetImports'
import {
  collectSubtreeImports,
  indentBlock,
  refuse,
  renameSubtreeComponents,
  renderJsxNode,
  validateSubtree,
  type InsertJsxChildren,
  type InsertJsxNode,
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
  /**
   * Props written onto the new element. Entries whose value is `undefined` are
   * skipped. A direct value `{ __assetImport: './assets/hero.png' }` (IMG-10)
   * writes `prop={heroPng}` AND `import heroPng from './assets/hero.png'` in
   * the same splice — see `jsxAssetImports.ts`.
   */
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
  /**
   * P5-B (IMG-2) — more NEW elements written immediately after this one, in
   * order, at the same anchor and in the SAME splice: N siblings, one write.
   *
   * ## Why one splice and not N inserts
   *
   * Every insert shifts the line of everything below it, so N independent
   * inserts are N writes, N re-parses and N undo steps for what the user did
   * as ONE gesture (dropping three images at once). Rendering the whole run
   * into one placement edit makes it one write whose undo is one step, and
   * nothing in the run needs an id before the next one is written.
   *
   * Validated as a whole before a byte is written, like `children`: one
   * refused sibling means nothing is written at all. Meant to be shared with
   * SVG-5's multi-node insert, which is why the shape is the insert's own
   * {@link InsertJsxNode} rather than anything image-specific.
   */
  siblings?: readonly InsertJsxNode[]
  /** Optional pre-existing project to reuse. */
  project?: Project
}

/**
 * `created` is every NEW top-level element's own tag-name `line:col` in the
 * file this call just wrote, in source order — the element itself first, then
 * each of `siblings` — the half of the answer the caller cannot derive,
 * because no element has a node id until the board re-parses. EMPTY when the
 * write landed but the positions could not be confirmed against the re-parsed
 * file (all of them or none: a partial list would pair an id with the wrong
 * element); see `createdJsxLocation.ts` for why that is never guessed at.
 */
export type InsertJsxElementResult =
  | { ok: true; created: readonly CreatedJsxLocation[] }
  | { ok: false; refusal: InsertJsxRefusal }

export function insertJsxElement(params: InsertJsxElementParams): InsertJsxElementResult {
  const { file, line, col, name, importSpecifier, children } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)

  // The run this call writes: the element itself, then every sibling.
  const run: InsertJsxNode[] = [
    {
      name,
      props: params.props,
      ...(importSpecifier === undefined ? {} : { importSpecifier }),
      ...(children === undefined ? {} : { children }),
    },
    ...(params.siblings ?? []),
  ]

  // IMG-10 — every image import the run's props ask for (`src={__assetImport}`)
  // joins the component imports below, so ONE binding plan names them all and
  // nothing the file already declares is shadowed.
  const assets = collectAssetImports(run)
  if (!assets.ok) {
    return refuse('asset-import', `"${assets.specifier}" is not an image path Studio will write as an import.`)
  }

  // Only a component name can collide: an intrinsic tag is a string to JSX,
  // never a reference to a binding, so a local `const div = …` is irrelevant
  // to `<div />`. Every component in the run, not just the root, is bound to
  // a local name that shadows nothing (WB-19), and written by that name.
  const required = new Map<string, ImportRequirement>()
  for (const node of run) for (const [local, requirement] of collectSubtreeImports(node)) required.set(local, requirement)
  for (const [local, requirement] of assets.required) required.set(local, requirement)
  const bindings = planImportBindings(sourceFile, required)
  const bound = run.map((node) => bindAssetImports(node, assets.nameFor, bindings.localName))

  // Validated for the WHOLE run before a single byte is written — a refusal
  // three levels down, or in the third sibling, must leave the file
  // untouched, not half-built.
  for (const node of bound) {
    const invalid = validateSubtree(node)
    if (invalid) return invalid
  }

  const parentOpening = findJsxElementAtLocation(sourceFile, line, col)
  if (!parentOpening) {
    return refuse(
      'not-found',
      `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    )
  }

  const renamed = bound.map((node) => renameSubtreeComponents(node, bindings.localName))

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
    (indent, unit) => renderSiblingRun(renamed, indent, unit),
  )
  if (!placement.ok) return placement

  const importEdits = resolveImportEdits(sourceFile, verbatim, bindings.required)

  writeVerbatimSource(sourceFile, file, applyTextEdits(verbatim, [placement.edit, ...importEdits]))
  // Only the IMPORT edits move the splice point: they sit above the JSX, and
  // the placement edit's own start is the thing being located.
  const blockStart = offsetAfterEdits(importEdits, placement.edit.start)
  return { ok: true, created: createdRunLocations(sourceFile, blockStart, placement.edit.text, run.length) }
}

/**
 * A run of sibling elements as the one block a placement writes. Each element
 * after the first starts on its own line at the placement's indentation — the
 * shape a hand-written list of siblings has. An INLINE placement (an empty
 * `indent`: the newcomers join a row the user kept on one line) joins them
 * with a space instead, so the row stays one line.
 */
function renderSiblingRun(nodes: readonly InsertJsxNode[], indent: string, unit: string): string {
  const separator = indent === '' ? ' ' : `\n${indent}`
  return nodes.map((node) => indentBlock(renderJsxNode(node, unit), indent)).join(separator)
}

/**
 * Where each element of a just-written run landed. One element keeps
 * `createdJsxLocation`'s first-`<` rule; a run is READ off the re-parsed file
 * (`createdJsxLocationsIn`), and only a count that matches what was written is
 * trusted — see {@link InsertJsxElementResult}.
 */
function createdRunLocations(
  sourceFile: SourceFile,
  blockStart: number,
  block: string,
  count: number,
): CreatedJsxLocation[] {
  if (count === 1) {
    const created = createdJsxLocation(sourceFile, blockStart, block)
    return created ? [created] : []
  }
  const located = createdJsxLocationsIn(sourceFile, blockStart, blockStart + block.length)
  return located.length === count ? located : []
}
