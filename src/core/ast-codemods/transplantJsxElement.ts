/**
 * transplantJsxElement — D2 G3, the write behind dragging an element out of
 * one frame and dropping it into a container in ANOTHER frame: a move whose
 * two ends are in two different files.
 *
 * ## Why this is not `moveJsxElement`'s reparent form
 *
 * `moveJsxElement` documents its same-file limit as a limit "of what a
 * cross-file move would MEAN, not of the splice": the markup would land in a
 * different module, where the bindings it reads do not exist. That sentence is
 * still exactly right — and it is also the specification of this codemod. A
 * cross-file move is honest precisely when every name the subtree reads
 * either travels with it or is already bound at the DESTINATION's. What
 * travels (`transplantBindings.ts` decides, name by name): an import, a
 * context-hook read, and the plain constants and handlers the element reads
 * (G-1a - COPIED into the destination, transitively). What the component OWNS
 * - a prop, state, a ref, a `.map` row's parameter, a `let` - cannot travel, so
 * the gesture refuses and names it.
 *
 * So the difference from a reparent is not the splice; it is one extra
 * question (which bindings travel) and one extra write (the destination's
 * import block). Its own module because those two things are the whole file,
 * and because a reparent must not grow a "if the files differ" branch — the
 * two gestures refuse for genuinely different reasons and a shared body would
 * have to explain both.
 *
 * ## Both writes, or neither
 *
 * Every refusal is decided BEFORE the first byte is written, and both files'
 * next contents are computed in full before either is put on disk. There is
 * no ordering in which this function can leave the origin's markup deleted and
 * the destination's copy unwritten: a refusal returns with two untouched
 * files, and a success writes two complete ones. (The only residue outside
 * that guarantee is the operating system losing the second `writeFileSync`
 * after the first succeeded — the same exposure every multi-file codemod in
 * this repo has, and not one a codemod can close.)
 *
 * ## Copy vs. move
 *
 * `copy: true` (Alt held during the drag, K2's gesture extended across frames)
 * writes the destination half and leaves the origin's bytes exactly where they
 * are. Everything else — the scope analysis, the import carry, the placement —
 * is identical, which is the point: an Alt-drag across frames must refuse for
 * the same reasons and land in the same place as the move it is a variant of.
 *
 * ## Byte-exactness
 *
 * The AST locates; the writes are splices of the original bytes (see
 * `jsxChildRange.ts`). The subtree's own text is never rewritten — only
 * re-indented to the destination's depth (`reindentBlock`, leading whitespace
 * only), the same treatment `moveJsxElement`'s reparent gives it. A reference
 * inside it (`{label}`, `<Icon/>`) is written into the new file verbatim,
 * because nothing about HOW it is written changes — only which module now
 * provides the binding, which is what the carried imports answer.
 *
 * ## Imports the origin no longer needs
 *
 * Not this codemod's job, deliberately, and for `pruneOrphanedImports.ts`'s
 * own stated reasons: an import lives at the TOP of a file, so cutting its
 * line mid-batch shifts every edit still queued below it, and a binding used
 * by two elements moved in the same batch is orphaned by neither alone. The
 * save route's existing post-batch prune pass covers a transplant exactly as
 * it covers a delete — see `applyStudioEditBatch`.
 */
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocation, loadSourceFile } from './locateJsxElement'
import {
  applyTextEdits,
  resolveJsxChildRange,
  verbatimSourceText,
  writeVerbatimSource,
  type TextEdit,
} from './jsxChildRange'
import { lineIndentAt, reindentBlock, resolveChildPlacement } from './jsxChildPlacement'
import { resolveImportEdits } from './jsxImportEdits'
import { createdJsxLocation, offsetAfterEdits, type CreatedJsxLocation } from './createdJsxLocation'
import type { InsertJsxRefusalReason } from './jsxSubtree'
import { buildCanvasLayerModule } from './canvasLayerModule'
import { enclosingFunctionComponent } from './detachHooks'
import { applySubtreeRenames } from './transplantCarry'
import { resolveCarriedBindings, type CarriedDeclaration } from './transplantBindings'

export interface TransplantJsxElementParams {
  /** Absolute path to the file the element is written in today. */
  file: string
  /** 1-based line/col of the moved element's tag-name start. */
  line: number
  col: number
  /**
   * Absolute path to the file the element is moving INTO. Must be a different
   * file from `file` — compared on the REAL path, so a case variant or a
   * symlink/junction naming the same bytes refuses as `same-file` too.
   */
  destinationFile: string
  /** 1-based line/col of the container element in `destinationFile`. */
  destinationLine: number
  destinationCol: number
  /**
   * 1-based line/col of an existing child of the destination to land beside.
   * Absent appends as the last child, which is a real position — the same
   * reading `insert` and `reparent` already give a missing anchor.
   */
  anchorLine?: number
  anchorCol?: number
  position?: 'before' | 'after'
  /** K2 across frames: write the destination half and leave the origin untouched. */
  copy?: boolean
  /** Optional pre-existing project to reuse (both files are loaded into it). */
  project?: Project
}

export type TransplantJsxRefusalReason =
  // Everything `resolveChildPlacement` can refuse in the DESTINATION, plus the
  // two this codemod owns: the scope check, and the same-file misuse guard.
  | InsertJsxRefusalReason
  | 'same-file'
  | 'captured-scope'
  // `sec-17` — the origin declares the binding but does not export it, so
  // there is no import the destination could carry that would resolve.
  | 'unexported-binding'

export interface TransplantJsxRefusal {
  reason: TransplantJsxRefusalReason
  /** Human-readable, suitable for a refusal dialog. */
  message: string
}

/**
 * `created` is the element's own tag-name `line:col` **in the DESTINATION
 * file** — a move writes markup that did not exist there a moment ago, and
 * that position is the only thing that can name it before the board re-parses
 * (`store-13`, `createdJsxLocation.ts`). `null` when the re-parsed destination
 * does not confirm an element there; never a guess.
 */
export type TransplantJsxElementResult =
  | { ok: true; carriedImports: string[]; carriedDeclarations: CarriedDeclaration[]; created: CreatedJsxLocation | null }
  | { ok: false; refusal: TransplantJsxRefusal }

function refuseTransplant(
  reason: TransplantJsxRefusalReason,
  message: string,
): { ok: false; refusal: TransplantJsxRefusal } {
  return { ok: false, refusal: { reason, message } }
}

/**
 * The identity of a file ON DISK, not the identity of the string naming it.
 *
 * `realpathSync.native` resolves symlinks AND — on Windows and macOS —
 * canonicalises the case, so `pages/Home.tsx`, `pages/home.tsx` and
 * `mirror/Home.tsx` (a junction) all collapse to one answer. Falls back to a
 * plain `resolve` for a path that does not exist yet, which for this codemod's
 * two ends means "one of them is about to refuse as `not-found` anyway".
 */
function fileIdentity(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

export function transplantJsxElement(params: TransplantJsxElementParams): TransplantJsxElementResult {
  const { file, line, col, destinationFile } = params

  // Compared on the REAL path, never on the two strings. A same-file gesture
  // that slips through here is not a no-op: both ends load as SEPARATE ts-morph
  // source files backed by the same bytes, the destination's spliced text is
  // written first, and the origin's — computed from the pre-edit text with the
  // element cut out — then overwrites it wholesale. The element is deleted from
  // the user's repository and never inserted anywhere, and the codemod returns
  // `ok`. `studioEditLocation`'s guard is lexical (`sec-17`), so two node ids
  // can legitimately name one file: a case difference on a case-insensitive
  // filesystem, or a symlink/junction of the kind git itself stores.
  if (fileIdentity(file) === fileIdentity(destinationFile)) {
    return refuseTransplant(
      'same-file',
      'Both ends of this move are in the same file, which is an ordinary reparent — this write exists only for the cross-file case.',
    )
  }

  const project = params.project ?? createProject()
  const originSource = loadSourceFile(project, file)
  const destinationSource = loadSourceFile(project, destinationFile)

  // WB-20 — a MOVE of `{cond && <X/>}` carries the condition with it, exactly
  // as a same-file move does. A copy stays element-only, like ⌘D.
  const target = resolveJsxChildRange(originSource, line, col, params.copy ? 'element' : 'conditional')
  if (!target.ok) return refuseTransplant(target.reason, target.message)

  const originText = verbatimSourceText(originSource, file)
  const destinationText = verbatimSourceText(destinationSource, destinationFile)
  if (originText === null || destinationText === null) {
    return refuseTransplant(
      'stale-source',
      'One of these files changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }

  const landed = landInDestination(
    { element: target.range.element, source: originSource, text: originText },
    { ...params, source: destinationSource, text: destinationText },
  )
  if (!landed.ok) return landed
  const nextOrigin = params.copy
    ? null
    : applyTextEdits(originText, [{ start: target.range.start, end: target.range.end, text: '' } satisfies TextEdit])

  // ── Writes ──────────────────────────────────────────────────────────────
  // The destination first: it is the half that has to exist for the gesture
  // to have produced anything at all. A move whose second write is lost by
  // the OS leaves the element in both files — visible, recoverable, and
  // reported by the parse — where the reverse order would lose it entirely.
  const created = landed.write()
  if (nextOrigin !== null) writeVerbatimSource(originSource, file, nextOrigin)

  return { ok: true, carriedImports: landed.carriedImports, carriedDeclarations: landed.carriedDeclarations, created }
}

/** The element being carried, and the file it is written in. */
interface TransplantOrigin {
  element: Node
  source: SourceFile
  text: string
}

/** Where it lands: a container (and optionally a sibling) in another, already-read file. */
interface TransplantDestination {
  destinationFile: string
  destinationLine: number
  destinationCol: number
  anchorLine?: number
  anchorCol?: number
  position?: 'before' | 'after'
  source: SourceFile
  text: string
}

/**
 * The DESTINATION half every cross-file write shares — a frame-to-frame move
 * (`transplantJsxElement`) and a loose layer placed into a frame
 * (`placeCanvasLayerRoot`): the scope question, the placement and the import
 * carry, all decided before anything is written. `write` then puts the
 * destination on disk and reports where the element landed.
 */
function landInDestination(
  origin: TransplantOrigin,
  destination: TransplantDestination,
):
  | { ok: true; carriedImports: string[]; carriedDeclarations: CarriedDeclaration[]; write: () => CreatedJsxLocation | null }
  | { ok: false; refusal: TransplantJsxRefusal } {
  const container = findJsxElementAtLocation(destination.source, destination.destinationLine, destination.destinationCol)
  if (!container) {
    return refuseTransplant(
      'not-found',
      `No JSX element is written at line ${destination.destinationLine}, column ${destination.destinationCol} of the destination file any more — it changed since the canvas last read it. Reload and try again.`,
    )
  }

  // ── The scope question, and the only one that makes a cross-file move
  //    different from a same-file one ────────────────────────────────────
  const componentBody = enclosingFunctionComponent(container)?.getBody()
  const destinationBody = componentBody && Node.isBlock(componentBody) ? componentBody : undefined
  // Where copied declarations are written: a component-body one goes right
  // before the statement of the body that holds the container, a module-level
  // one right before the top-level statement that holds it.
  const bodyAnchor = destinationBody ? container.getAncestors().find((ancestor) => ancestor.getParent() === destinationBody) : undefined
  const moduleAnchor = container.getAncestors().find((ancestor) => Node.isSourceFile(ancestor.getParent()))
  const bodyIndent = bodyAnchor ? lineIndentAt(destination.text, bodyAnchor.getStart()) : '  '
  const carried = resolveCarriedBindings(origin.element, origin.source, origin.text, {
    source: destination.source,
    file: destination.destinationFile,
    bodyIndent,
    ...(destinationBody && bodyAnchor ? { body: destinationBody } : {}),
  })
  if (!carried.ok) return refuseTransplant(carried.refusal.reason, carried.refusal.message)

  const rawSubtree = origin.text.slice(origin.element.getStart(), origin.element.getEnd())
  const subtree = applySubtreeRenames(rawSubtree, origin.element.getStart(), origin.element, carried.renames)
  const fromIndent = lineIndentAt(origin.text, origin.element.getStart())

  const placement = resolveChildPlacement(
    destination.source,
    destination.text,
    container,
    {
      anchor:
        destination.anchorLine !== undefined && destination.anchorCol !== undefined
          ? { line: destination.anchorLine, col: destination.anchorCol }
          : null,
      ...(destination.position ? { position: destination.position } : {}),
    },
    (indent) => reindentBlock(subtree, fromIndent, indent),
  )
  if (!placement.ok) {
    return refuseTransplant(placement.refusal.reason, placement.refusal.message)
  }

  const importEdits = resolveImportEdits(destination.source, destination.text, carried.requirements)
  // Order matters at an equal offset (`applyTextEdits` lands a LATER entry first):
  // an import above a copied module declaration, a hook above a copied body one.
  const carryEdits: TextEdit[] = []
  if (carried.moduleStatements.length > 0 && moduleAnchor) {
    const at = moduleAnchor.getStart(true)
    carryEdits.push({ start: at, end: at, text: carried.moduleStatements.map((statement) => `${statement}\n\n`).join('') })
  }
  if (carried.bodyStatements.length > 0 && bodyAnchor) {
    const at = bodyAnchor.getStart()
    carryEdits.push({ start: at, end: at, text: carried.bodyStatements.map((statement) => `${statement}\n${bodyIndent}`).join('') })
  }
  const priorEdits = [...carryEdits, ...importEdits, ...carried.hookEdits]
  const nextDestination = applyTextEdits(destination.text, [placement.edit, ...priorEdits])

  return {
    ok: true,
    carriedImports: [...carried.requirements.keys()],
    carriedDeclarations: carried.carried,
    write: () => {
      writeVerbatimSource(destination.source, destination.destinationFile, nextDestination)
      // Measured against the DESTINATION, which `writeVerbatimSource` has just
      // re-read, and shifted past the import lines and re-established hook
      // call this write added above the JSX — the same arithmetic
      // `insertJsxElement` performs for its own copy.
      return createdJsxLocation(destination.source, offsetAfterEdits(priorEdits, placement.edit.start), placement.edit.text)
    },
  }
}

// ---------------------------------------------------------------------------
// The free canvas's two endpoints (P5-G, FC-2)
// ---------------------------------------------------------------------------

/**
 * The element a free-canvas layer module returns — the loose layer's root.
 *
 * Found STRUCTURALLY (the default export's returned JSX), never from a caller's
 * `line:col`: the layer's identity is its file, and this is the one element a
 * layer module is allowed to contain at the top. `undefined` when the module
 * is not in that shape (edited outside Studio into something else).
 */
export function canvasLayerModuleRoot(source: SourceFile): Node | undefined {
  const declaration = source.getDefaultExportSymbol()?.getDeclarations()[0]
  if (!declaration) return undefined
  const body = Node.isFunctionDeclaration(declaration) || Node.isArrowFunction(declaration) || Node.isFunctionExpression(declaration)
    ? declaration.getBody()
    : undefined
  if (!body) return undefined
  const expression = Node.isBlock(body)
    ? body.getStatements().find((statement) => Node.isReturnStatement(statement))?.asKind(SyntaxKind.ReturnStatement)?.getExpression()
    : body
  let root = expression
  while (root && Node.isParenthesizedExpression(root)) root = root.getExpression()
  if (!root) return undefined
  return Node.isJsxElement(root) || Node.isJsxSelfClosingElement(root) || Node.isJsxFragment(root) ? root : undefined
}

export interface PlaceCanvasLayerRootParams {
  /** Absolute path of the layer module (`.studio/canvas/<id>.tsx`). */
  moduleFile: string
  destinationFile: string
  destinationLine: number
  destinationCol: number
  anchorLine?: number
  anchorCol?: number
  position?: 'before' | 'after'
  project?: Project
}

/**
 * PLACE — a loose layer dropped into a frame: the module's root element is
 * written into a container in the page, carrying its imports, exactly as a
 * frame-to-frame move writes its destination half.
 *
 * The module itself is left untouched here. It is the caller's to delete once
 * this has written (a move) or to keep (Alt: a copy) — the module is Studio's
 * own file under `.studio/canvas/`, and removing it is `canvasLayerFiles.ts`'s
 * job, the one place allowed to touch that directory.
 */
export function placeCanvasLayerRoot(params: PlaceCanvasLayerRootParams): TransplantJsxElementResult {
  if (fileIdentity(params.moduleFile) === fileIdentity(params.destinationFile)) {
    return refuseTransplant('same-file', 'A canvas layer cannot be placed into its own module.')
  }
  const project = params.project ?? createProject()
  const moduleSource = loadSourceFile(project, params.moduleFile)
  const destinationSource = loadSourceFile(project, params.destinationFile)
  const moduleText = verbatimSourceText(moduleSource, params.moduleFile)
  const destinationText = verbatimSourceText(destinationSource, params.destinationFile)
  if (moduleText === null || destinationText === null) {
    return refuseTransplant(
      'stale-source',
      'The canvas layer or the page changed on disk since the canvas last read it. Reload the project and try again.',
    )
  }
  const root = canvasLayerModuleRoot(moduleSource)
  if (!root) {
    return refuseTransplant(
      'not-found',
      'This canvas layer no longer returns a single element, so there is nothing Studio can place. Open the file and give it one root element.',
    )
  }
  const landed = landInDestination(
    { element: root, source: moduleSource, text: moduleText },
    { ...params, source: destinationSource, text: destinationText },
  )
  if (!landed.ok) return landed
  const created = landed.write()
  return { ok: true, carriedImports: landed.carriedImports, carriedDeclarations: landed.carriedDeclarations, created }
}

export interface LiftJsxElementParams {
  /** Absolute path of the page file the element is written in. */
  file: string
  line: number
  col: number
  /** Absolute path of the NEW layer module (it must not exist yet). */
  moduleFile: string
  /** Alt: leave the element in the page and put a copy on the canvas. */
  copy?: boolean
  /**
   * Writes the new module's text — exclusively, refusing if the name exists.
   * The caller's, because it is `.studio/canvas/` and only
   * `canvasLayerFiles.ts` writes there. Called BEFORE the page is touched: if
   * it throws, nothing has been written anywhere.
   */
  writeModule: (text: string) => void
  project?: Project
}

export type LiftJsxElementResult =
  | { ok: true; carriedImports: string[]; root: CreatedJsxLocation }
  | { ok: false; refusal: TransplantJsxRefusal }

/**
 * LIFT — an element dragged out of a frame onto the empty board becomes a new
 * loose layer: its bytes, verbatim and re-indented to column 0, become the
 * root of a new layer module, with every binding it reads carried as an
 * import resolved from the module's own location. A move then cuts it out of
 * the page; a copy leaves the page alone.
 *
 * The same scope rule as a frame-to-frame move, for the same reason: a
 * context-hook read (`t` from `useLanguage()`) re-establishes its call in the
 * layer component, and markup that reads a prop, any other hook result or a
 * `.map` row's parameter refuses `captured-scope` by name. (Design §7 turns that
 * refusal into an automatic copy with the values baked in; that needs the
 * substitution engine P1-E/P5-C build and is not in this change.)
 */
export function liftJsxElementToCanvasModule(params: LiftJsxElementParams): LiftJsxElementResult {
  const project = params.project ?? createProject()
  const originSource = loadSourceFile(project, params.file)
  const originText = verbatimSourceText(originSource, params.file)
  if (originText === null) {
    return refuseTransplant('stale-source', 'This page changed on disk since the canvas last read it. Reload the project and try again.')
  }

  const target = resolveJsxChildRange(originSource, params.line, params.col)
  let element: Node
  let removal: TextEdit | null = null
  if (target.ok) {
    element = target.range.element
    if (!params.copy) removal = { start: target.range.start, end: target.range.end, text: '' }
  } else {
    // A COPY reads the element and writes nothing back, so the outermost
    // element of a page is as copyable as any other; a MOVE of it would leave
    // the component returning nothing.
    const opening = params.copy && target.reason === 'no-jsx-parent'
      ? findJsxElementAtLocation(originSource, params.line, params.col)
      : undefined
    if (!opening) return refuseTransplant(target.reason, target.message)
    element = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParentOrThrow()
  }

  // The module does not exist yet, so nothing in it can conflict: an empty
  // component answers `conflictingBinding` honestly, and is the body a
  // context hook the element reads (`const { t } = useLanguage()`) is
  // re-established in — the SAME carry a frame-to-frame move makes, so a lift
  // refuses and succeeds for exactly the reasons that move does.
  const emptyLayer = new Project({ useInMemoryFileSystem: true }).createSourceFile(
    '/layer.tsx',
    'export default function CanvasLayer() {}\n',
  )
  const carried = resolveCarriedBindings(element, originSource, originText, {
    source: emptyLayer,
    file: params.moduleFile,
    bodyIndent: '  ',
    body: emptyLayer.getFunctionOrThrow('CanvasLayer').getBodyOrThrow().asKindOrThrow(SyntaxKind.Block),
  })
  if (!carried.ok) return refuseTransplant(carried.refusal.reason, carried.refusal.message)

  const subtree = applySubtreeRenames(
    originText.slice(element.getStart(), element.getEnd()),
    element.getStart(),
    element,
    carried.renames,
  )
  const built = buildCanvasLayerModule(
    reindentBlock(subtree, lineIndentAt(originText, element.getStart()), ''),
    carried.requirements,
    [...carried.hookStatements, ...carried.bodyStatements],
    carried.moduleStatements,
  )

  params.writeModule(built.text)
  if (removal) writeVerbatimSource(originSource, params.file, applyTextEdits(originText, [removal]))

  return { ok: true, carriedImports: [...carried.requirements.keys()], root: built.root }
}
