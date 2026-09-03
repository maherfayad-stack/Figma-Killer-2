/**
 * studioStructuralWriteback — the three studio edit kinds that change WHERE
 * markup is rather than what it says: `move`, `delete` and `insert`
 * (`struct-01`, `struct-02`). Their schemas and their dispatch into
 * `@core/ast-codemods`, in one place.
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
import { deleteJsxElement, duplicateJsxElement, insertJsxElement, moveJsxElement } from '@core/ast-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'

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
 * rather than simply "no writable location". It is not refused for orphaning
 * an import: the codemod removes any binding the deleted markup alone was
 * using, the same way `insert` adds the ones it needs.
 */
const DeleteEditSchema = Type.Object({
  kind: Type.Literal('delete'),
  nodeId: Type.String(),
})

/**
 * One element copied in place (`struct-01`) — `duplicateJsxElement`.
 *
 * The same one-field shape as a delete, and for the same reason: the element
 * names itself and the destination is implied. A duplicate always lands
 * immediately after its original, so unlike an insert there is no anchor or
 * position to carry — the copy's place is not a choice the user made, it is
 * what "duplicate" means.
 */
const DuplicateEditSchema = Type.Object({
  kind: Type.Literal('duplicate'),
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
 */
/**
 * Any JSON value — `insertJsxElement`'s `JsonDataValue`, which it renders as a
 * JSX expression (`items={[{ label: "Home" }]}`).
 *
 * Recursive rather than the flat scalar union it was, because that union was
 * silently costing every structured default its trip to disk: a TabBar inserted
 * with the package's own documented `items` was written as `<TabBar
 * platform="ios" value={0}/>` and reloaded from source as an empty bar.
 */
export const JsonDataValueSchema = Type.Recursive((Self) =>
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(Self), Type.Record(Type.String(), Self)]),
)

/**
 * A React element in PROP position — `insertJsxElement`'s `JsxPropElement`.
 *
 * `<TabBar items={[{ icon: <svg…/>, label: 'Home' }]}/>` is the documented shape
 * of a tab bar, and an icon that cannot be written is an empty icon slot on
 * every tab. The element arrives as a VALIDATED TREE, never as source text, and
 * goes through the same `validateSubtree` tag-safety refusal every child
 * element already does — so this widens what can be written, not what can be
 * injected.
 *
 * Intrinsic tags with scalar props only — see `JsxPropElementNode`. A prop
 * element is a glyph, not a scene, and the missing `importSpecifier` is what
 * makes `validateSubtree` refuse a capitalised tag here.
 */
const JsxPropElementNodeSchema = Type.Recursive((Self) =>
  Type.Object({
    name: Type.String(),
    props: Type.Optional(Type.Record(Type.String(), JsonDataValueSchema)),
    children: Type.Optional(Type.Union([Type.String(), Type.Array(Self)])),
  }),
)

const JsxPropValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Object({ __jsx: JsxPropElementNodeSchema }),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
)

const InsertPropsSchema = Type.Record(Type.String(), JsxPropValueSchema)

/**
 * One element in an insert's subtree. Recursive through `children`, which is
 * EITHER literal text or a list of nested elements — see `insertJsxElement`'s
 * `InsertJsxChildren` for why mixed content is excluded.
 *
 * `Type.Recursive` is what makes the nesting expressible as a real schema
 * rather than an `unknown` the handler would have to re-validate by hand; the
 * MCP tool advertises this verbatim as JSON Schema, so the model sees the
 * actual shape it may send.
 */
const InsertNodeSchema = Type.Recursive((Self) =>
  Type.Object({
    name: Type.String(),
    importSpecifier: Type.Optional(Type.String()),
    props: Type.Optional(InsertPropsSchema),
    children: Type.Optional(Type.Union([Type.String(), Type.Array(Self)])),
  }),
)

const InsertEditSchema = Type.Object({
  kind: Type.Literal('insert'),
  nodeId: Type.String(),
  anchorNodeId: Type.Optional(Type.String()),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('after')])),
  name: Type.String(),
  importSpecifier: Type.Optional(Type.String()),
  children: Type.Optional(Type.Union([Type.String(), Type.Array(InsertNodeSchema)])),
  props: Type.Optional(InsertPropsSchema),
})

/** The four structural edit kinds, folded into `StudioEditSchema` by `studioWriteback.ts`. */
export const StructuralEditSchemas = [MoveEditSchema, DeleteEditSchema, DuplicateEditSchema, InsertEditSchema] as const

export const StructuralEditSchema = Type.Union([...StructuralEditSchemas])
export type StructuralEdit = Static<typeof StructuralEditSchema>

/** A decoded, already path-guarded source location. */
interface JsxLocation {
  file: string
  line: number
  col: number
}

/** Applied, or refused with a reason the caller turns into a `StudioEditRefusalError`. */
export type StructuralEditOutcome = { ok: true } | { ok: false; reason: string; message: string }

/** The structural edit kinds, for the caller's `kind`-based branching. */
export function isStructuralEditKind(kind: string): kind is StructuralEdit['kind'] {
  return kind === 'move' || kind === 'delete' || kind === 'duplicate' || kind === 'insert'
}

/**
 * Run one structural edit's codemod.
 *
 * `anchor` is the caller's already-decoded, same-file `anchorNodeId`, or `null`
 * when the edit carried none or it named a different file. The two kinds treat
 * that absence differently, and the difference is not an oversight:
 *
 *  - A **move** without a same-file anchor is a refusal. "Put this element
 *    before that one" is the entire content of the edit; without the anchor
 *    there is no order to write.
 *  - An **insert** without one simply appends. The anchor is a refinement on
 *    top of a container that is already an honest target, so dropping it costs
 *    the user a position they can fix with a drag — refusing would cost them
 *    the whole action.
 */
export function applyStructuralEdit(
  loc: JsxLocation,
  edit: StructuralEdit,
  anchor: { line: number; col: number } | null,
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
      return result.ok ? { ok: true } : { ok: false, ...result.refusal }
    }
    case 'delete': {
      const result = deleteJsxElement(loc)
      return result.ok ? { ok: true } : { ok: false, ...result.refusal }
    }
    case 'duplicate': {
      // No anchor: a copy goes immediately after what it copied, which the
      // codemod derives from the element's own byte range.
      const result = duplicateJsxElement(loc)
      return result.ok ? { ok: true } : { ok: false, ...result.refusal }
    }
    case 'insert': {
      // `importSpecifier`/`children` are spread conditionally rather than
      // passed as `undefined`: the codemod reads `importSpecifier === undefined`
      // as "write an intrinsic tag" and `children === undefined` as "write an
      // empty element", so an explicitly-undefined key must mean the same
      // thing as an absent one.
      const result = insertJsxElement({
        ...loc,
        ...(anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, position: edit.position } : {}),
        name: edit.name,
        props: edit.props,
        ...(edit.importSpecifier === undefined ? {} : { importSpecifier: edit.importSpecifier }),
        ...(edit.children === undefined ? {} : { children: edit.children }),
      })
      return result.ok ? { ok: true } : { ok: false, ...result.refusal }
    }
  }
}
