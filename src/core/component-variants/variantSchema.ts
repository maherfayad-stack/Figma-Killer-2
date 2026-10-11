/**
 * variantSchema — the wire shape of the VARIANT READ MODEL: what one local
 * component's enum/boolean props are, where their members are written, and
 * HOW the component's own source turns each prop into styling.
 *
 * A pure schema leaf (TypeBox + derived types, no ts-morph, no postcss), so the
 * server's analyzer (`src/core/page-parser/componentVariantBindings.ts`) and the
 * browser's catalog client (`componentPropKind.ts`) validate the SAME shapes
 * instead of keeping two mirrors in step by hand. The browser must never import
 * the parser barrel (it drags ts-morph into the bundle), which is why this lives
 * in its own leaf.
 *
 * Everything here is READ off the written source. Nothing is executed; a
 * binding is only ever claimed when BOTH the consuming expression and the thing
 * it points at (a CSS rule, an object entry) resolved in the files on disk.
 * Anything the analyzer cannot prove is `opaque`, and carries the line that
 * defeated it so a later writer can refuse with a reason a person can act on.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/** A span in a workspace file. Lines and columns are 1-based, like node ids. */
const SourceRangeSchema = Type.Object({
  /** POSIX path relative to the workspace root. */
  file: Type.String(),
  line: Type.Integer({ minimum: 1 }),
  column: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  endColumn: Type.Integer({ minimum: 1 }),
})
export type SourceRange = Static<typeof SourceRangeSchema>

/** One member of a string-literal union, with the literal's own location when it is written inside the workspace. */
const VariantMemberSchema = Type.Object({
  name: Type.String(),
  origin: Type.Optional(SourceRangeSchema),
})
export type VariantMember = Static<typeof VariantMemberSchema>

/**
 * Where the union that defines the members is written. Only `inline` and
 * `same-file-alias` are one edit in the component's own file; `other-file` is
 * writable only if that file is also in the workspace (it always is, here: an
 * alias the analyzer could not find reports nothing at all).
 */
const UnionHomeSchema = Type.Union([
  Type.Literal('inline'),
  Type.Literal('same-file-alias'),
  Type.Literal('other-file'),
])
export type UnionHome = Static<typeof UnionHomeSchema>

/** The CSS rule that styles one member (css-module class map, data-attribute selector). */
const VariantRuleSchema = Type.Object({
  member: Type.String(),
  selector: Type.String(),
  range: SourceRangeSchema,
})
export type VariantRule = Static<typeof VariantRuleSchema>

/** The object entry / cva key that carries one member's classes. */
const VariantEntrySchema = Type.Object({
  member: Type.String(),
  range: SourceRangeSchema,
})
export type VariantEntry = Static<typeof VariantEntrySchema>

/**
 * HOW a component consumes one enum/boolean prop. `kind` is the write
 * strategy a later bundle (Add variant) would need; `opaque` is the honest
 * "this renders, but Studio cannot write it" with the line that says why.
 */
const VariantBindingSchema = Type.Union([
  /**
   * `styles[variant]` / ``styles[`btn-${variant}`]`` against a CSS module
   * (`scope: 'module'`), or ``className={`btn-${variant}`}`` against a plain
   * stylesheet the component imports (`scope: 'global'`). `expr` is the written
   * expression; `rules` the rule found for each member that has one.
   */
  Type.Object({
    kind: Type.Literal('css-module-class'),
    scope: Type.Union([Type.Literal('module'), Type.Literal('global')]),
    expr: Type.String(),
    range: SourceRangeSchema,
    rules: Type.Array(VariantRuleSchema),
  }),
  /** `data-variant={variant}` with `[data-variant="ghost"]` rules in an imported stylesheet. */
  Type.Object({
    kind: Type.Literal('data-attr'),
    attr: Type.String(),
    range: SourceRangeSchema,
    rules: Type.Array(VariantRuleSchema),
  }),
  /** `const variantClass: Record<Variant, string> = { primary: '…' }` indexed by the prop. */
  Type.Object({
    kind: Type.Literal('lookup-object'),
    objectName: Type.String(),
    range: SourceRangeSchema,
    entries: Type.Array(VariantEntrySchema),
  }),
  /** `cva(base, { variants: { variant: { primary: '…' } } })` called with the prop. `callee` is the imported name (`cva`, `tv`). */
  Type.Object({
    kind: Type.Literal('cva'),
    callee: Type.String(),
    group: Type.String(),
    range: SourceRangeSchema,
    entries: Type.Array(VariantEntrySchema),
  }),
  /** `cn(base, disabled && 'is-disabled')` — the class literal a boolean switches on. */
  Type.Object({
    kind: Type.Literal('boolean-class'),
    range: SourceRangeSchema,
    className: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('opaque'),
    file: Type.String(),
    /** The line that defeated the analyzer (or the declaration, when the prop is never read). */
    line: Type.Integer({ minimum: 1 }),
    reason: Type.String(),
  }),
])
export type VariantBinding = Static<typeof VariantBindingSchema>

/** A prop's literal default (`variant = 'primary'`), exactly as written. */
const PropDefaultSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()])
export type PropDefault = Static<typeof PropDefaultSchema>

/**
 * The variant fields a LOCAL component's prop carries on top of `PropSpec`.
 * All optional and additive: a prop the analyzer has nothing to say about
 * (a string, a handler, an unreadable body) has none of them.
 */
export const PropVariantFieldsSchema = Type.Object({
  /** The destructuring default (`variant = 'primary'`), when the author wrote one. */
  defaultValue: Type.Optional(PropDefaultSchema),
  /** Enum props only: each union member with the location of its literal. */
  members: Type.Optional(Type.Array(VariantMemberSchema)),
  unionHome: Type.Optional(UnionHomeSchema),
  /** Enum and boolean props: how the component's own code consumes the prop. */
  binding: Type.Optional(VariantBindingSchema),
})
export type PropVariantFields = Static<typeof PropVariantFieldsSchema>
