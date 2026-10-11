/**
 * schema — the token catalog as it crosses the wire (`GET /admin/api/studio/token-catalog`)
 * and as the editor's variable picker, the Variables panel and the agent's
 * `studio_set_tokens` all read it.
 *
 * The catalog is derived from disk on every request; nothing here is
 * persisted. A token is a CSS custom property (project stylesheets, plus
 * Tailwind v4 `@theme`); Studio's own Framework scales are a generator, not
 * the user's token layer, and are folded in by the editor as a separate,
 * read-only "Framework" collection (CT-OD-1).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { ModeGateSchema } from './gates'

/** Where a declaration's stylesheet came from. Only `project` is edited in place. */
export const TokenOriginSchema = Type.Union([
  Type.Literal('project'),
  Type.Literal('package'),
  Type.Literal('studio-design-system'),
  Type.Literal('compiled'),
])
export type TokenOrigin = Static<typeof TokenOriginSchema>

export const TokenFamilySchema = Type.Union([
  Type.Literal('color'),
  Type.Literal('type'),
  Type.Literal('space'),
  Type.Literal('radius'),
  Type.Literal('shadow'),
  Type.Literal('other'),
])
export type TokenFamily = Static<typeof TokenFamilySchema>

export const TokenDeclSchema = Type.Object({
  gate: ModeGateSchema,
  /** The selector it is written under (`:root`, `[data-theme="dark"]`), `null` straight inside `@theme`. */
  selector: Type.Union([Type.String(), Type.Null()]),
  atRules: Type.Array(Type.String()),
  /** The value as written. */
  value: Type.String(),
  /** The value with its `var()` chain followed, in the declaration's own mode. */
  resolvedValue: Type.String(),
  aliasOf: Type.Optional(Type.String()),
  /** Project-relative path, a package specifier, or a label for compiled output. */
  file: Type.String(),
  /** 1-based; `null` for compiled output, whose lines point at nothing a person edits. */
  line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  origin: TokenOriginSchema,
  /** True when it is the declaration the canvas paints for its gate (the last in cascade order). */
  winning: Type.Boolean(),
  inTheme: Type.Boolean(),
})
export type TokenDecl = Static<typeof TokenDeclSchema>

export const TokenUsageSchema = Type.Object({
  count: Type.Integer({ minimum: 0 }),
  /** The first places it is used; `count` is the true total. */
  sites: Type.Array(Type.Object({ file: Type.String(), line: Type.Integer({ minimum: 1 }) })),
})
export type TokenUsage = Static<typeof TokenUsageSchema>

export const CatalogTokenSchema = Type.Object({
  name: Type.String(),
  family: TokenFamilySchema,
  collection: Type.String(),
  /** Every declaration of the token, source order. */
  decls: Type.Array(TokenDeclSchema),
  /** Only when the request asked for usage. */
  usage: Type.Optional(TokenUsageSchema),
})
export type CatalogToken = Static<typeof CatalogTokenSchema>

export const TokenCollectionSchema = Type.Object({
  /** `<file>#<leading name segment>` — `src/tokens.css#color`. */
  id: Type.String(),
  label: Type.String(),
  file: Type.String(),
  origin: TokenOriginSchema,
  editable: Type.Boolean(),
})
export type TokenCollection = Static<typeof TokenCollectionSchema>

export const ModeAxisSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  /** The default mode is implicit (the `base` gate); these are the extra ones found. */
  modes: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), gate: ModeGateSchema })),
})
export type ModeAxis = Static<typeof ModeAxisSchema>

/**
 * One value a JavaScript theme defines (CT-6): a Tailwind v3 `tailwind.config.js`
 * `theme` / `theme.extend` entry, or an entry of a design-token object file
 * (`theme.ts`) that config reads. Not a CSS custom property: it has no `--name`
 * and Studio never runs the file to learn its value, so it is listed and
 * applied by utility class, never edited. `readOnlyReason` is the sentence the
 * panel shows: exactly why, and what to do instead.
 */
export const JsThemeEntrySchema = Type.Object({
  /** Stable: `<file>#<dotted path>`. */
  id: Type.String(),
  file: Type.String(),
  /** 1-based line of the value in `file`. */
  line: Type.Integer({ minimum: 1 }),
  /** Where the value was found: the Tailwind config itself, or a token file it reads (or that stands alone). */
  source: Type.Union([Type.Literal('tailwind-config'), Type.Literal('theme-file')]),
  /** The theme group: `colors`, `spacing`, `fontSize`... */
  group: Type.String(),
  /** The dotted path inside the group: `primary.500` (`DEFAULT` kept as written). */
  path: Type.String(),
  family: TokenFamilySchema,
  /** The value as written in the file. */
  raw: Type.String(),
  /** The value when it is a literal; `null` when it is computed (a spread, a call, a `require`, a reference), which Studio does not run. */
  value: Type.Union([Type.String(), Type.Null()]),
  /** The classes that apply it (`bg-primary-500`); empty when no Tailwind config reads this file or the group has none. */
  utilities: Type.Array(Type.String()),
  readOnlyReason: Type.String(),
})
export type JsThemeEntry = Static<typeof JsThemeEntrySchema>

export const TokenCatalogSchema = Type.Object({
  tokens: Type.Array(CatalogTokenSchema),
  collections: Type.Array(TokenCollectionSchema),
  axes: Type.Array(ModeAxisSchema),
  /** Only when the request asked for the Variables panel's full read. */
  jsTheme: Type.Optional(Type.Array(JsThemeEntrySchema)),
})
export type TokenCatalog = Static<typeof TokenCatalogSchema>

/** One edit the token write route (and `studio_set_tokens`) plans. */
export const TokenTargetSchema = Type.Union([Type.Literal('light'), Type.Literal('dark'), ModeGateSchema])
export type TokenTarget = Static<typeof TokenTargetSchema>

export const TokenEditSchema = Type.Union([
  Type.Object({
    op: Type.Literal('set'),
    name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120 }),
    value: Type.String({ minLength: 1, maxLength: 300 }),
    target: Type.Optional(TokenTargetSchema),
  }),
  Type.Object({
    op: Type.Literal('insert'),
    name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120 }),
    value: Type.String({ minLength: 1, maxLength: 300 }),
    target: Type.Optional(TokenTargetSchema),
    /** Project-relative stylesheet to declare it in; default is chosen by the server. */
    file: Type.Optional(Type.String({ maxLength: 300 })),
  }),
  /**
   * Rename a token: every declaration (all modes) and every mention in project
   * source moves to `to`, in one write. Always the only edit in its request.
   */
  Type.Object({
    op: Type.Literal('rename'),
    name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120 }),
    to: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120 }),
  }),
  /**
   * Remove a token: all of its declarations. A token that is still read needs
   * `replaceWith` (another declared token the readers move to); an unused one
   * does not. Always the only edit in its request.
   */
  Type.Object({
    op: Type.Literal('remove'),
    name: Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120 }),
    replaceWith: Type.Optional(Type.String({ pattern: '^--[A-Za-z0-9_-]+$', maxLength: 120 })),
  }),
])
export type TokenEdit = Static<typeof TokenEditSchema>
