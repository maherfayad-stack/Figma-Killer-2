/**
 * studioInsertJsxSchemas — the wire shapes `insert`'s SUBTREE and PROPS need,
 * split out of `studioStructuralWriteback.ts` at the `module-size-budgets`
 * ceiling. These types have no dispatch behaviour of their own — they exist
 * only to be embedded inside `InsertEditSchema` (and, via `JsonDataValueSchema`,
 * inside a slot fill's props too) — so moving them here costs the dispatch
 * module nothing but line count.
 *
 * One-way dependency: this module imports nothing from
 * `studioStructuralWriteback.ts`, which imports these back.
 */
import { Type } from '@core/utils/typeboxHelpers'

/**
 * "This tag comes from Studio's built-in design system" — the one thing the
 * client can say about a design-system import, because the specifier itself is
 * a path only the server can compute. A literal `true` rather than a boolean so
 * `designSystemImport: false` cannot be sent and read as an assertion.
 */
export const DesignSystemImportSchema = Type.Literal(true, {
  description:
    "The tag comes from Studio's built-in design system, reached through the project's own design-system/ folder. The server computes the relative specifier for the file being written (a page at pages/Home.tsx gets '../design-system') — do NOT also send importSpecifier, and never guess the path yourself. Takes precedence if both are sent.",
})

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

/**
 * P5-B3 (IMG-10) — an image IMPORT in prop position: the WORKSPACE-relative
 * path of an image file the new element reads through an import. The server
 * guards the path and spells the specifier from the file being written
 * (`studioInsertAssetImports.ts`); the codemod writes the default import and
 * `prop={name}` in the same splice. Honoured on an `insert`'s direct props
 * only — anywhere else `validateSubtree` refuses it.
 */
const AssetImportPropSchema = Type.Object({
  __assetImport: Type.String({
    maxLength: 1024,
    description: 'Workspace-relative path of an image file in this project, written as a default import plus prop={name}.',
  }),
})

const JsxPropValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Object({ __jsx: JsxPropElementNodeSchema }),
    AssetImportPropSchema,
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
)

export const InsertPropsSchema = Type.Record(Type.String(), JsxPropValueSchema)

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
export const InsertNodeSchema = Type.Recursive((Self) =>
  Type.Object({
    name: Type.String(),
    importSpecifier: Type.Optional(Type.String()),
    designSystemImport: Type.Optional(DesignSystemImportSchema),
    props: Type.Optional(InsertPropsSchema),
    children: Type.Optional(Type.Union([Type.String(), Type.Array(Self)])),
  }),
)
