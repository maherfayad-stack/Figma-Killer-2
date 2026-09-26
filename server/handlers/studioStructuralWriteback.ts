/**
 * studioStructuralWriteback — the studio edit kinds that change WHERE markup is
 * rather than what it says: `move`, `delete`, `insert` (`struct-01`,
 * `struct-02`), `duplicate`, `wrap` and `reparent` (W4-1), `group` /
 * `ungroup` (K3), and `transplant` (D2 G3). Their schemas and their dispatch into
 * `@core/ast-codemods`, in one place.
 *
 * `transplant` is the one kind with its OWN entry point
 * ({@link applyTransplantEdit}) rather than a branch of
 * {@link applyStructuralEdit}: its destination is in a DIFFERENT FILE, which
 * that function's same-file `{ line, col }` parameters cannot express. It is
 * excluded from `applyStructuralEdit`'s parameter type, so routing it to the
 * wrong one does not compile.
 *
 * Split out of `studioWriteback.ts` for the same reason `studioCssWriteback.ts`
 * was: that module owns the VALUE edits, which all share one shape — decode a
 * `rel:line:col`, hand it to a writer that rewrites an attribute or a literal
 * in place. A structural edit is a different shape of write. It relocates,
 * removes or creates whole elements, so it needs a second location (an anchor
 * sibling), it changes the file's line count (invalidating every id below it),
 * and every one of them can REFUSE for reasons only the AST can see. Two
 * reasons to change, two modules.
 *
 * The dependency runs ONE WAY. `studioWriteback.ts` folds these schemas into
 * the `StudioEdit` union, decodes and path-guards both the target and the
 * anchor, and calls `applyStructuralEdit`; this module imports nothing back.
 * That is why it returns a plain refusal object rather than throwing
 * `StudioEditRefusalError` — the error class belongs to the caller's batch
 * protocol, not to the codemods.
 *
 * WHAT REFUSES HERE VS. EARLIER. The store already refused everything decidable
 * from a node id alone (`refuseStructuralEdit` in `@core/page-tree`: a `.map`
 * row, a shared component, route chrome). What is left is the residue only a
 * parse can answer — these two elements are not really siblings, their
 * formatting will not admit a byte-exact move, this insert would shadow a name
 * the file already binds.
 */
import {
  deleteJsxElement,
  duplicateJsxElement,
  insertJsxElement,
  moveJsxElement,
  transplantJsxElement,
  unwrapJsxElement,
  wrapJsxElement,
  wrapJsxElements,
  type CreatedJsxLocation,
} from '@core/ast-codemods'
import { designSystemImportSpecifier } from '@core/page-parser'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { DesignSystemImportSchema, InsertNodeSchema, InsertPropsSchema } from './studioInsertJsxSchemas'

/**
 * One sibling reorder (`struct-01`) — `moveJsxElement`. `nodeId` is the moved
 * element's own location; `anchorNodeId` is the sibling it is written against,
 * because an INDEX does not name a position in the source (one `{items.map(…)}`
 * child contributes N canvas nodes, a `{cond && <X/>}` contributes one of two,
 * whitespace contributes none) while "immediately before/after that element"
 * does. Both ids decode through the same `studioEditLocation` every other kind
 * shares, so ordering and touched-file collection keep working.
 */
const MoveEditSchema = Type.Object({
  kind: Type.Literal('move'),
  nodeId: Type.String(),
  anchorNodeId: Type.String(),
  position: Type.Union([Type.Literal('before'), Type.Literal('after')]),
})

/**
 * One element removal (`struct-01`) — `deleteJsxElement`. Like `detach`/`swap`
 * this can REFUSE with a specific reason (it is the component's root return)
 * rather than simply "no writable location". Not refused for orphaning an
 * import: the codemod removes any binding the deleted markup alone was using.
 *
 * Its ⌘Z is the undo journal's `restore` (P3-F, `studio/undoJournal.ts`): the
 * editor's batch records what the file was before this ran.
 */
const DeleteEditSchema = Type.Object({
  kind: Type.Literal('delete'),
  nodeId: Type.String(),
})

/**
 * One new element written into the user's source (`struct-02`) —
 * `insertJsxElement`, the write behind adding a design-system component from
 * the canvas picker.
 *
 * `nodeId` is the CONTAINER's location, not the new element's: the new element
 * has no location until this write gives it one, which is the whole reason the
 * editor asks the source to grow it instead of minting a canvas node. The
 * optional `anchorNodeId`/`position` name an existing sibling to write beside,
 * for the same reason `move` uses an anchor rather than an index; without them
 * the element is appended as the last child.
 *
 * `props` carries any JSON value, because a design system's content often IS
 * one: `<TabBar items={[{ label: 'Home' }]}/>`. What has no JSON form at all —
 * a handler, a React element, a slot sentinel — is dropped by the client before
 * it gets here rather than guessed at.
 *
 * `importSpecifier` is OPTIONAL, and its presence is what picks between the
 * two things this edit can write: with it, `name` is a component and the
 * import is written alongside; without it, `name` is an intrinsic HTML tag
 * (`div`, `span`, `button`) that needs no import. See `insertJsxElement`'s
 * "COMPONENTS AND INTRINSIC TAGS" — an agent composing a screen needs the
 * layout elements, not only the design-system components that sit inside them.
 *
 * `designSystemImport` is the third case, and it exists because the CLIENT
 * CANNOT SPELL IT. Studio's built-in design system is reached through the
 * project's own `design-system/` folder, so its specifier is relative to the
 * file being written — `'../design-system'` from `pages/Home.tsx`,
 * `'../../design-system'` from `pages/account/Settings.tsx`. The editor does
 * not know where the target file sits in the tree; the server does, having
 * just decoded the node id through `studioEditLocation`. So the client says
 * WHICH SYSTEM and the server computes the PATH
 * (`designSystemImportSpecifier`). See {@link resolveInsertImports}.
 *
 * `DesignSystemImportSchema`/`InsertPropsSchema`/`InsertNodeSchema` — the
 * subtree and prop shapes this schema embeds — live in
 * `studioInsertJsxSchemas.ts` (`module-size-budgets`).
 */
const InsertEditSchema = Type.Object({
  kind: Type.Literal('insert'),
  nodeId: Type.String(),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
  name: Type.String(),
  importSpecifier: Type.Optional(Type.String()),
  designSystemImport: Type.Optional(DesignSystemImportSchema),
  children: Type.Optional(Type.Union([Type.String(), Type.Array(InsertNodeSchema)])),
  props: Type.Optional(InsertPropsSchema),
  /**
   * P5-B (IMG-2) — more new elements written immediately AFTER this one, in
   * order, in the same write: dropping three images is ONE insert of three
   * siblings, one resync and one undo step, not three queued inserts. Each
   * entry is the same node shape `children` carries. `createdNodeIds` reports
   * every one of them, in order.
   */
  siblings: Type.Optional(Type.Array(InsertNodeSchema, { minItems: 1 })),
})

/**
 * One element copied (W4-1, extended by K2) — `duplicateJsxElement`. `nodeId`
 * is the element being copied.
 *
 * With no `parentNodeId` the copy lands as its own next sibling, in the same
 * scope — the ⌘D / toolbar gesture, and the only form that existed before K2.
 * With one, the copy lands INSIDE that container instead (Alt+drag), and the
 * optional `anchorNodeId`/`position` name an existing child of it to land
 * beside, for the same reason `move` uses an anchor rather than an index.
 * Without them the copy is appended as the last child, which is a real
 * position — the same reading `insert` and `reparent` already give.
 *
 * Cross-FILE is refused before it reaches here, exactly as it is for
 * `reparent`: `applyStudioEdit` drops a `parentNodeId` that decodes to another
 * file, and the store refuses the gesture with `cross-file` from the two ids
 * alone.
 */
const DuplicateEditSchema = Type.Object({
  kind: Type.Literal('duplicate'),
  nodeId: Type.String(),
  parentNodeId: Type.Optional(Type.String()),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
})

/**
 * One element wrapped in a new container (W4-1) — `wrapJsxElement`. `nodeId` is
 * the element being wrapped; `name`/`importSpecifier` spell the wrapper exactly
 * as `insert` spells a new element (an intrinsic tag with no specifier, a
 * component with one, and the import written alongside).
 *
 * The wrapper carries no props: it is a container the user is about to style on
 * the canvas, and writing a module's schema defaults into their source as
 * attributes would put Studio's own vocabulary in their repository.
 */
const WrapEditSchema = Type.Object({
  kind: Type.Literal('wrap'),
  nodeId: Type.String(),
  name: Type.String(),
  importSpecifier: Type.Optional(Type.String()),
  designSystemImport: Type.Optional(DesignSystemImportSchema),
})

/**
 * One container written around a RUN of siblings (K3) — `wrapJsxElements`, the
 * write behind ⌘G on a multi-selection.
 *
 * `nodeId` is the FIRST element of the run and `siblingNodeIds` are the rest,
 * in source order — not one `nodeIds` array, because every other part of the
 * save route (bottom-to-top ordering, the touched-file set, the containment
 * guard) is keyed on `nodeId` and a group must sort by the topmost position it
 * changes. The codemod re-derives the run from the AST and refuses
 * (`not-contiguous`) if anything unnamed sits between the ends, so a
 * hand-crafted batch cannot widen the span.
 *
 * ⌘G on ONE element is not this kind: it is the existing `wrap`, unchanged.
 *
 * `name`/`importSpecifier`/`designSystemImport` spell the container exactly as
 * `wrap` and `insert` spell theirs.
 */
const GroupEditSchema = Type.Object({
  kind: Type.Literal('group'),
  nodeId: Type.String(),
  siblingNodeIds: Type.Array(Type.String(), { minItems: 1 }),
  name: Type.String(),
  importSpecifier: Type.Optional(Type.String()),
  designSystemImport: Type.Optional(DesignSystemImportSchema),
})

/**
 * One container dissolved (K3) — `unwrapJsxElement`, the write behind ⌘⇧G. Its
 * children take its place at its own index, and the container's own bytes go.
 *
 * `nodeId` is the container, and it is the only field: everything else is
 * decided by what is written at that location. The codemod refuses
 * (`has-behaviour`) when the container carries anything but
 * `className`/`style`/`id`/`data-*`, because deleting an element that also
 * carries a handler, a ref, a `key` or a spread would drop behaviour no undo
 * in the editor can explain.
 */
const UngroupEditSchema = Type.Object({
  kind: Type.Literal('ungroup'),
  nodeId: Type.String(),
})

/**
 * One element moved into a DIFFERENT parent (W4-1) — `moveJsxElement`'s
 * destination-parent form. `parentNodeId` is the new container; the optional
 * `anchorNodeId`/`position` name an existing child of it to land beside, for the
 * same reason `move` uses an anchor rather than an index. Without them the
 * element is appended as the last child, which is a real position — the same
 * reading `insert` already gives a missing anchor.
 *
 * Cross-FILE is refused before it reaches here: `applyStudioEdit` drops a
 * `parentNodeId` that decodes to another file, and the store refuses the gesture
 * with `cross-file` from the two ids alone.
 */
const ReparentEditSchema = Type.Object({
  kind: Type.Literal('reparent'),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
})

/**
 * One element moved (or copied) into a container in a DIFFERENT FILE (D2 G3)
 * — `transplantJsxElement`, the write behind dragging an element out of one
 * board frame and dropping it into another.
 *
 * `parentNodeId` is the new container, and unlike every other structural kind
 * it is EXPECTED to decode to a different file from `nodeId`; a
 * `parentNodeId` in the same file is an ordinary `reparent` and this kind
 * refuses it rather than quietly doing the other write. The optional
 * `anchorNodeId`/`position` name an existing child of the destination to land
 * beside, and belong to the DESTINATION's file — they are decoded against it,
 * not against the moved element's.
 *
 * `copy` is K2's Alt+drag extended across frames: the destination half is
 * written and the origin's markup is left exactly where it is.
 *
 * Unlike `reparent`, cross-file is the POINT here rather than the refusal, so
 * the two residual questions only the AST can answer arrive from the codemod:
 * `captured-scope` (the markup reads a binding local to the component it is
 * leaving) and `binding-conflict` (the destination already means something
 * else by a name the move would carry).
 */
const TransplantEditSchema = Type.Object({
  kind: Type.Literal('transplant'),
  nodeId: Type.String(),
  parentNodeId: Type.String(),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
  copy: Type.Optional(Type.Boolean()),
})

/** The structural edit kinds, folded into `StudioEditSchema` by `studioWriteback.ts`. */
export const StructuralEditSchemas = [
  MoveEditSchema,
  DeleteEditSchema,
  InsertEditSchema,
  DuplicateEditSchema,
  WrapEditSchema,
  GroupEditSchema,
  UngroupEditSchema,
  ReparentEditSchema,
  TransplantEditSchema,
] as const

export const StructuralEditSchema = Type.Union([...StructuralEditSchemas])
export type StructuralEdit = Static<typeof StructuralEditSchema>


/** A decoded, already path-guarded source location. */
interface JsxLocation {
  file: string
  line: number
  col: number
}

/**
 * One wire node's import, resolved to the string `insertJsxElement` writes
 * verbatim. `undefined` means an intrinsic tag, which needs none.
 *
 * `designSystemImport` wins when both fields are set: it is the only one that
 * names a SYSTEM rather than a path, and the path it resolves to is computed
 * from the file actually being written rather than guessed by the sender. A
 * client that sends both is a client that does not know where the file lives —
 * which is exactly the case this field exists for.
 */
function resolveNodeImport(
  node: { importSpecifier?: string; designSystemImport?: true },
  targetRel: string,
): string | undefined {
  if (node.designSystemImport) return designSystemImportSpecifier(targetRel)
  return node.importSpecifier
}

/**
 * A JSX node as it arrives on the wire, in the one shape shared by every
 * writeback that renders a subtree: `insert`'s `children`, and
 * `studioSlotWriteback.ts`'s slot fill. Generic in the prop value type only
 * because those two schemas differ there (a slot value carries plain JSON, an
 * insert prop may also carry a `{__jsx}` element) — the import fields, which
 * are all this resolver touches, are identical.
 */
export interface ImportableJsxNode<TProps> {
  name: string
  importSpecifier?: string
  designSystemImport?: true
  props?: TProps
  children?: string | ImportableJsxNode<TProps>[]
}

/**
 * Resolves `designSystemImport` into a real specifier through a whole subtree
 * — a nested `children` array may name design-system components at any depth,
 * and every one of them resolves against the SAME file, because the subtree is
 * written into one file in one splice.
 *
 * Returns a new tree; the validated wire object is never mutated, and
 * `designSystemImport` does not survive into the codemod's input (the codemod
 * knows only specifiers — see `insertJsxElement`'s "COMPONENTS AND INTRINSIC
 * TAGS").
 */
export function resolveDesignSystemImports<TProps>(
  nodes: readonly ImportableJsxNode<TProps>[],
  targetRel: string,
): ImportableJsxNode<TProps>[] {
  return nodes.map((node) => {
    const specifier = resolveNodeImport(node, targetRel)
    const children = node.children
    return {
      name: node.name,
      ...(specifier === undefined ? {} : { importSpecifier: specifier }),
      ...(node.props === undefined ? {} : { props: node.props }),
      ...(children === undefined
        ? {}
        : { children: typeof children === 'string' ? children : resolveDesignSystemImports(children, targetRel) }),
    }
  })
}

/**
 * Applied, or refused with a reason the caller turns into a
 * `StudioEditRefusalError`.
 *
 * `created` (`store-13`) is the tag-name `line:col` of every element this
 * write brought into existence, in source order — an `insert`'s new child (or
 * its run of siblings, P5-B IMG-2), a `duplicate`'s copy, a `wrap`/`group`'s
 * container. Absent for the kinds that create nothing (`move`, `delete`,
 * `reparent`, `ungroup`), and empty when the codemod wrote but could not
 * confirm the position against the re-parsed file. The caller mints the node
 * ids from it; see `createdJsxLocation.ts` for why it is never guessed at.
 *
 * `relocated` (`store-14`) is the same coordinate for the elements this write
 * MOVED rather than made — a `move`/`reparent`'s element in its new slot, an
 * `ungroup`'s released children, a `transplant`'s element in the destination
 * file. Absent for the kinds that move nothing, and subject to the identical
 * never-guess rule.
 */
export type StructuralEditOutcome =
  | { ok: true; created?: readonly CreatedJsxLocation[]; relocated?: readonly CreatedJsxLocation[] }
  | { ok: false; reason: string; message: string }

/** A single-element codemod's `created` in the outcome's list shape: its one location, or nothing when it could not confirm one. */
function createdList(created: CreatedJsxLocation | null): CreatedJsxLocation[] {
  return created ? [created] : []
}

/** The structural edit kinds, for the caller's `kind`-based branching. */
export function isStructuralEditKind(kind: string): kind is StructuralEdit['kind'] {
  return (
    kind === 'move' ||
    kind === 'delete' ||
    kind === 'insert' ||
    kind === 'duplicate' ||
    kind === 'wrap' ||
    kind === 'group' ||
    kind === 'ungroup' ||
    kind === 'reparent' ||
    kind === 'transplant'
  )
}

/** A decoded, already path-guarded location in a file OTHER than the edit's own target. */
export interface ForeignJsxLocation {
  file: string
  line: number
  col: number
}

/**
 * D2 G3 — run the cross-file move. Its own entry point rather than another
 * branch of {@link applyStructuralEdit} because it is the one structural kind
 * whose second and third locations are in a DIFFERENT FILE: every other kind
 * takes `{ line, col }` pairs that are only meaningful alongside `loc.file`,
 * and widening that shared parameter to carry a file would make eight
 * same-file kinds read as if they might not be.
 *
 * `destination` is the already-decoded, already-path-guarded container in the
 * other file; `anchor` is an existing child of it (decoded against the
 * DESTINATION's file, never the origin's). A `null` destination is the
 * caller's guard having refused the id — the same fail-closed reading
 * `applyStructuralEdit` gives its own `null`s.
 */
export function applyTransplantEdit(
  loc: JsxLocation,
  edit: Extract<StructuralEdit, { kind: 'transplant' }>,
  destination: ForeignJsxLocation | null,
  anchor: ForeignJsxLocation | null,
): StructuralEditOutcome {
  if (!destination) {
    return {
      ok: false,
      reason: 'not-found',
      message:
        'The frame this element would move into is no longer backed by a file Studio can write. Reload the project and try again.',
    }
  }
  const result = transplantJsxElement({
    file: loc.file,
    line: loc.line,
    col: loc.col,
    destinationFile: destination.file,
    destinationLine: destination.line,
    destinationCol: destination.col,
    ...(anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position } : {}),
    ...(edit.copy ? { copy: true } : {}),
  })
  if (!result.ok) return { ok: false, ...result.refusal }
  // `store-13`/`store-14` — the position is in the DESTINATION file, so
  // `applyStudioEditBatch` has to mint its node id against that file rather
  // than against the edit's own `nodeId`. See its `transplant` branch.
  //
  // A COPY created an element; a MOVE relocated one. The two are reported
  // through different fields because their undos differ — a copy is taken back
  // by deleting what it made, a move by transplanting the element home — and
  // `resolveStructuralInverse` reads exactly one of them per template.
  return edit.copy
    ? { ok: true, created: createdList(result.created) }
    : { ok: true, relocated: createdList(result.created) }
}

/**
 * Run one structural edit's codemod.
 *
 * `anchor` is the caller's already-decoded, same-file `anchorNodeId`, or `null`
 * when the edit carried none or it named a different file. The kinds treat that
 * absence differently, and the difference is not an oversight:
 *
 *  - A **move** without a same-file anchor is a refusal. "Put this element
 *    before that one" is the entire content of the edit; without the anchor
 *    there is no order to write.
 *  - An **insert** or a **reparent** without one simply appends. The anchor is a
 *    refinement on top of a container that is already an honest target, so
 *    dropping it costs the user a position they can fix with a drag — refusing
 *    would cost them the whole action.
 *
 * `destination` is the same-file decoding of a `reparent`'s `parentNodeId`. It
 * is `null` for every other kind, and a `null` on a reparent is `cross-file`:
 * the new parent is in another module, where the markup's bindings do not exist.
 *
 * `targetRel` is `loc.file`'s workspace-relative POSIX path — already decoded
 * and path-guarded by the caller's `studioEditLocation`, and the one input a
 * `designSystemImport` needs to become a real specifier
 * (see {@link resolveNodeImport}).
 *
 * `siblings` (K3) is a `group`'s remaining run members, decoded through that
 * same guard and filtered to the SAME FILE — a shorter list than the edit
 * named is a cross-file group, which refuses. Empty for every other kind.
 */
export function applyStructuralEdit(
  loc: JsxLocation,
  /**
   * Every structural kind EXCEPT `transplant`, whose second and third
   * locations are in another file and which therefore has its own entry point
   * ({@link applyTransplantEdit}). Excluded in the TYPE rather than handled by
   * a dead branch here, so the switch below stays exhaustive and a caller that
   * routes a transplant to the wrong function does not compile.
   */
  edit: Exclude<StructuralEdit, { kind: 'transplant' }>,
  anchor: { line: number; col: number } | null,
  destination: { line: number; col: number } | null,
  targetRel: string,
  siblings: readonly { line: number; col: number }[] = [],
): StructuralEditOutcome {
  switch (edit.kind) {
    case 'move': {
      if (!anchor) {
        return {
          ok: false,
          reason: 'cross-file',
          message:
            'The element this move is written against is not in the same file, so there is no single place to write the new order.',
        }
      }
      const result = moveJsxElement({
        ...loc,
        anchorLine: anchor.line,
        anchorCol: anchor.col,
        position: edit.position,
      })
      return result.ok
        ? { ok: true, relocated: result.relocated ? [result.relocated] : [] }
        : { ok: false, ...result.refusal }
    }
    case 'delete': {
      const result = deleteJsxElement(loc)
      return result.ok ? { ok: true } : { ok: false, ...result.refusal }
    }
    case 'insert': {
      // `importSpecifier`/`children` are spread conditionally rather than
      // passed as `undefined`: the codemod reads `importSpecifier === undefined`
      // as "write an intrinsic tag" and `children === undefined` as "write an
      // empty element", so an explicitly-undefined key must mean the same
      // thing as an absent one.
      const importSpecifier = resolveNodeImport(edit, targetRel)
      const children =
        edit.children === undefined || typeof edit.children === 'string'
          ? edit.children
          : resolveDesignSystemImports(edit.children, targetRel)
      // P5-B (IMG-2) — the run's other elements resolve their design-system
      // imports against the same file, through the same resolver `children`
      // uses, because they are written into it in the same splice.
      const siblings = edit.siblings ? resolveDesignSystemImports(edit.siblings, targetRel) : undefined
      const result = insertJsxElement({
        ...loc,
        ...(anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position } : {}),
        name: edit.name,
        props: edit.props,
        ...(importSpecifier === undefined ? {} : { importSpecifier }),
        ...(children === undefined ? {} : { children }),
        ...(siblings === undefined ? {} : { siblings }),
      })
      return result.ok ? { ok: true, created: result.created } : { ok: false, ...result.refusal }
    }
    case 'duplicate': {
      // K2 — `parentNodeId` present means Alt+drag: the copy goes INTO that
      // container, not beside the original. A `parentNodeId` that decoded to
      // another file arrives here as `null` (the caller's cross-file guard),
      // which must refuse rather than silently fall back to an in-place copy:
      // the user asked for the copy to land somewhere else, and quietly
      // putting it next to the original is a different edit.
      if (edit.parentNodeId !== undefined && !destination) {
        return {
          ok: false,
          reason: 'cross-file',
          message:
            'The container this copy would go into is in a different file. Studio can copy an element into a new parent within one file; across files the markup would land where the values it reads do not exist.',
        }
      }
      const result = duplicateJsxElement({
        ...loc,
        ...(destination ? { destinationLine: destination.line, destinationCol: destination.col } : {}),
        ...(destination && anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position } : {}),
      })
      return result.ok ? { ok: true, created: createdList(result.created) } : { ok: false, ...result.refusal }
    }
    case 'wrap': {
      const wrapperSpecifier = resolveNodeImport(edit, targetRel)
      const result = wrapJsxElement({
        ...loc,
        name: edit.name,
        ...(wrapperSpecifier === undefined ? {} : { importSpecifier: wrapperSpecifier }),
      })
      return result.ok ? { ok: true, created: createdList(result.created) } : { ok: false, ...result.refusal }
    }
    case 'group': {
      // The run's REST arrive as their own decoded locations (`siblings`) —
      // the caller ran every one of them through `studioEditLocation`, so a
      // hand-crafted id cannot name a file outside the workspace, and one
      // naming a DIFFERENT file was dropped there rather than reaching a
      // codemod that would need an AST to notice.
      if (siblings.length !== edit.siblingNodeIds.length) {
        return {
          ok: false,
          reason: 'cross-file',
          message:
            'Some of the elements in this group are written in a different file, so there is no single place to write one container around them.',
        }
      }
      const wrapperSpecifier = resolveNodeImport(edit, targetRel)
      const result = wrapJsxElements({
        file: loc.file,
        targets: [{ line: loc.line, col: loc.col }, ...siblings],
        name: edit.name,
        ...(wrapperSpecifier === undefined ? {} : { importSpecifier: wrapperSpecifier }),
      })
      return result.ok ? { ok: true, created: createdList(result.created) } : { ok: false, ...result.refusal }
    }
    case 'ungroup': {
      const result = unwrapJsxElement(loc)
      return result.ok ? { ok: true, relocated: result.relocated } : { ok: false, ...result.refusal }
    }
    case 'reparent': {
      if (!destination) {
        return {
          ok: false,
          reason: 'cross-file',
          message:
            'The container this element would move into is in a different file. Studio can move an element to a new parent within one file; across files the markup would land where the values it reads do not exist.',
        }
      }
      const result = moveJsxElement({
        ...loc,
        destinationLine: destination.line,
        destinationCol: destination.col,
        ...(anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position } : {}),
      })
      return result.ok
        ? { ok: true, relocated: result.relocated ? [result.relocated] : [] }
        : { ok: false, ...result.refusal }
    }
  }
}
