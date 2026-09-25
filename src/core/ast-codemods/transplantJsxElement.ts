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
 * cross-file move is honest precisely when every name the subtree reads is
 * either resolvable at the ORIGIN file's module scope (so it can be CARRIED as
 * an import) or already bound at the DESTINATION's. Anything else — a prop, a
 * hook result, a `.map` row's parameter — is body-local to the origin's
 * component and cannot travel, so the gesture refuses and names it.
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
import { conflictingBinding, resolveImportEdits, type ImportRequirement } from './jsxImportEdits'
import { createdJsxLocation, offsetAfterEdits, type CreatedJsxLocation } from './createdJsxLocation'
import type { InsertJsxRefusalReason } from './jsxSubtree'
import { relativeSpecifier } from './importReconcile'
import { analyzeFreeVariables } from './subtreeFreeVariables'
import { buildCanvasLayerModule } from './canvasLayerModule'

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
  | { ok: true; carriedImports: string[]; created: CreatedJsxLocation | null }
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

  return { ok: true, carriedImports: landed.carriedImports, created }
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
  | { ok: true; carriedImports: string[]; write: () => CreatedJsxLocation | null }
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
  const carried = resolveCarriedBindings(origin.element, origin.source, destination.source, destination.destinationFile)
  if (!carried.ok) return carried

  const subtree = origin.text.slice(origin.element.getStart(), origin.element.getEnd())
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
  const nextDestination = applyTextEdits(destination.text, [placement.edit, ...importEdits])

  return {
    ok: true,
    carriedImports: [...carried.requirements.keys()],
    write: () => {
      writeVerbatimSource(destination.source, destination.destinationFile, nextDestination)
      // Measured against the DESTINATION, which `writeVerbatimSource` has just
      // re-read, and shifted past the import lines this write added above the
      // JSX — the same arithmetic `insertJsxElement` performs for its own copy.
      return createdJsxLocation(
        destination.source,
        offsetAfterEdits(importEdits, placement.edit.start),
        placement.edit.text,
      )
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
  return { ok: true, carriedImports: landed.carriedImports, created }
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
 * The same scope rule as a frame-to-frame move, for the same reason: markup
 * that reads a prop, a hook result or a `.map` row's parameter cannot resolve
 * anywhere else, so it refuses `captured-scope` by name. (Design §7 turns that
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

  // The module does not exist yet, so nothing in it can conflict; an empty
  // in-memory file answers `conflictingBinding` honestly.
  const emptyModule = new Project({ useInMemoryFileSystem: true }).createSourceFile('/layer.tsx', '')
  const carried = resolveCarriedBindings(element, originSource, emptyModule, params.moduleFile)
  if (!carried.ok) return carried

  const subtree = originText.slice(element.getStart(), element.getEnd())
  const built = buildCanvasLayerModule(
    reindentBlock(subtree, lineIndentAt(originText, element.getStart()), ''),
    carried.requirements,
  )

  params.writeModule(built.text)
  if (removal) writeVerbatimSource(originSource, params.file, applyTextEdits(originText, [removal]))

  return { ok: true, carriedImports: [...carried.requirements.keys()], root: built.root }
}

/**
 * Which of the subtree's free names travel with it, and whether any of them
 * cannot.
 *
 * Three buckets, and the partition is `analyzeFreeVariables`'s:
 *
 *  - **`kind: 'prop'`** — body-local to the origin's component (a destructured
 *    prop, a hook's binding, a `.map` row's parameter, a `const` in the
 *    component body). It has no module to be imported from, so the markup
 *    cannot resolve it anywhere else. Refused, by name — "some binding" is not
 *    something a person can act on.
 *  - **`kind: 'import'`, already bound at the destination's top level** —
 *    nothing to write. Left alone rather than re-imported, the same posture
 *    `addReconciledImports` takes: a real collision against a DIFFERENT source
 *    is caught below by `conflictingBinding`.
 *  - **`kind: 'import'`, not bound at the destination** — carried, either by
 *    mirroring the origin's own import declaration (following a relative
 *    specifier to the file it actually names and re-resolving it against the
 *    destination's location) or, for a helper the origin file declares itself,
 *    by importing it FROM the origin file.
 */
function resolveCarriedBindings(
  subtree: Node,
  originSource: SourceFile,
  destinationSource: SourceFile,
  destinationFile: string,
):
  | { ok: true; requirements: Map<string, ImportRequirement> }
  | { ok: false; refusal: TransplantJsxRefusal } {
  const free = analyzeFreeVariables(subtree, originSource)

  const captured = free.filter((variable) => variable.kind === 'prop').map((variable) => variable.name)
  if (captured.length > 0) {
    const names = captured.map((name) => `\`${name}\``).join(', ')
    const isOne = captured.length === 1
    return {
      ok: false,
      refusal: {
        reason: 'captured-scope',
        message:
          `This element reads ${names} from the component it is written in, and ${isOne ? 'that name belongs' : 'those names belong'} to that component's own body — there is no module the other file could import ${isOne ? 'it' : 'them'} from. ` +
          `Move it within its own frame, or lift ${isOne ? 'the value' : 'those values'} into a shared module first.`,
      },
    }
  }

  const requirements = new Map<string, ImportRequirement>()
  for (const variable of free) {
    const requirement = resolveCarriedBinding(variable.name, originSource, destinationFile)
    if (requirement === UNEXPORTED) {
      return {
        ok: false,
        refusal: {
          reason: 'unexported-binding',
          message:
            `This element reads "${variable.name}", which the file it is leaving declares but does not export — so the other file has no way to import it, and writing the move anyway would leave that file with an import of a name that is not there. ` +
            `Export "${variable.name}" from its own file first, then drag again.`,
        },
      }
    }
    if (!requirement) continue // a global, or a name nothing here can trace — left to the compiler to report
    const binding = conflictingBinding(destinationSource, variable.name, requirement.specifier)
    if (binding) {
      return {
        ok: false,
        refusal: {
          reason: 'binding-conflict',
          message: `The file this element would move into already uses the name "${variable.name}" for something else (${binding}), so carrying its import would shadow that. Rename one of them in the file first.`,
        },
      }
    }
    requirements.set(variable.name, requirement)
  }

  return { ok: true, requirements }
}

/**
 * The origin declares this name but keeps it to itself — see
 * {@link resolveCarriedBinding}.
 */
const UNEXPORTED = Symbol('unexported')

/**
 * Where `name` comes from, expressed as an import the DESTINATION file can
 * carry — or `undefined` when the origin file neither imports nor declares it
 * (a global, or a name this walk cannot trace, which `analyzeFreeVariables`
 * has already narrowed to almost nothing), or {@link UNEXPORTED} when the
 * origin declares it but does not export it.
 *
 * The same resolution `addReconciledImports` performs, expressed as a
 * REQUIREMENT rather than applied as a ts-morph mutation: this codemod writes
 * byte splices, and a ts-morph `addImportDeclaration` would reprint offsets the
 * splices were measured against.
 */
function resolveCarriedBinding(
  name: string,
  originSource: SourceFile,
  destinationFile: string,
): ImportRequirement | typeof UNEXPORTED | undefined {
  for (const declaration of originSource.getImportDeclarations()) {
    const specifierText = declaration.getModuleSpecifierValue()
    const specifier = specifierText.startsWith('.')
      ? relativeSpecifier(destinationFile, path.resolve(path.dirname(originSource.getFilePath()), specifierText))
      : specifierText

    if (declaration.getDefaultImport()?.getText() === name) return { specifier, style: 'default' }
    if (declaration.getNamespaceImport()?.getText() === name) return { specifier, style: 'namespace' }
    const named = declaration
      .getNamedImports()
      .some((entry) => (entry.getAliasNode() ?? entry.getNameNode()).getText() === name)
    if (named) return { specifier, style: 'named' }
  }

  // A helper the origin file declares itself: the destination imports it FROM
  // the origin. That only works when the origin EXPORTS it, and `sec-17` is
  // where this stopped being "the compiler will say so loudly". By the time
  // the compiler says anything the gesture has already written both files:
  // the markup is gone from the origin, the destination has an import of a
  // name that is not there, neither is undoable with ⌘Z (this whole edit
  // family mints no history entry), and the user's repo does not build. A
  // write that cannot land honestly in both files refuses — which is the
  // invariant, and the refusal names the one-line remedy.
  const declaration =
    originSource.getFunction(name) ?? originSource.getVariableDeclaration(name) ?? originSource.getClass(name)
  if (declaration) {
    return declaration.isExported()
      ? { specifier: relativeSpecifier(destinationFile, originSource.getFilePath()), style: 'named' }
      : UNEXPORTED
  }

  return undefined
}
