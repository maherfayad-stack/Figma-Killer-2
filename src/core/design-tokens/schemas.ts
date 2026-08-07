/**
 * design-tokens/schemas — the ONE `DesignToken` shape, replacing the
 * project-token half of `FrameworkSettings` (`@core/framework-schema`),
 * `ClassifiedTokens` (`tokenExtractCssScan.ts`), and `ProjectTokenIndex`
 * (`projectTokenIndex.ts`) — see `STUDIO-FIGMA-PARITY-PLAN.md` §11 (Track H)
 * for the full "seven token models" audit this closes part of.
 *
 * ## Why `name` and not a slug
 *
 * `FrameworkColorToken` mints its own `slug` and then generates up to 18
 * DERIVED variable names per token (transparency steps, shades, tints) that
 * exist only inside Studio's own injected `:root` block — never in the
 * user's real app (the exact bug Phase 0.13 partially patched: picking a
 * derived variant rendered correctly in Studio and as nothing outside it).
 * `DesignToken.name` is instead **the project's own custom-property name,
 * verbatim** — `--color-aqua-100`, never a re-slugged `color-aqua-100` or a
 * `-l-2` variant that was never declared anywhere. A name in the picker is a
 * name in the user's CSS, by construction — there is no separate step that
 * could let the two drift.
 *
 * ## `origin` — provenance, not ownership
 *
 * Every token traces to where it was found. `origin.kind === 'studio-authored'`
 * is the ONE kind Studio may freely re-emit into the canvas (it does not
 * shadow anything — nothing else declares that name); every other kind names
 * a real file the token was read out of, and the canvas must not re-declare
 * it (see the T4 note in this track's handoff for the precise canvas-side
 * fix, out of scope for this module).
 *
 * ## Families
 *
 * Extends `FrameworkSettings`'s three families (color / a typography *size*
 * ladder / spacing) with the ones real design systems ship and Studio had no
 * home for: `font-family`, `font-weight`, `line-height`, `letter-spacing`
 * (previously discarded wholesale as "typography-detail", see
 * `tokenExtractBuild.ts`'s "Shape gap" doc), `radius`, and `elevation`
 * (previously classified ONLY for the markdown design-system digest, see
 * `designSystemDigest.ts`).
 */
import { Type, type Static } from '../utils/typeboxHelpers'

export const DesignTokenFamilySchema = Type.Union([
  Type.Literal('color'),
  Type.Literal('font-family'),
  Type.Literal('font-size'),
  Type.Literal('font-weight'),
  Type.Literal('line-height'),
  Type.Literal('letter-spacing'),
  Type.Literal('space'),
  Type.Literal('radius'),
  Type.Literal('elevation'),
])
export type DesignTokenFamily = Static<typeof DesignTokenFamilySchema>

/**
 * Where a token was found. `project-css`/`vendor-css`/`tailwind-theme`/
 * `scss-source`/`js-theme` are all real-file provenance — the canvas must
 * treat their value as authoritative and must NOT re-declare them (see the
 * module doc). `studio-authored` is the one kind Studio itself may mint (the
 * explicit "New token" write path, T7 in the audit) — it has no source file
 * because Studio is the source.
 */
export const DesignTokenOriginKindSchema = Type.Union([
  Type.Literal('project-css'),
  Type.Literal('vendor-css'),
  Type.Literal('tailwind-theme'),
  Type.Literal('scss-source'),
  Type.Literal('js-theme'),
  Type.Literal('studio-authored'),
])
export type DesignTokenOriginKind = Static<typeof DesignTokenOriginKindSchema>

export const DesignTokenOriginSchema = Type.Object({
  kind: DesignTokenOriginKindSchema,
  /** Project-relative path the declaration was read from. Absent for `studio-authored` (no source file exists) and for a `tailwind-theme` value the config text was scanned from but attributing a single line is not meaningful. */
  file: Type.Optional(Type.String()),
  /** 1-based source line, when known — narrows `file` to the exact declaration for a "jump to source" affordance. */
  line: Type.Optional(Type.Number()),
})
export type DesignTokenOrigin = Static<typeof DesignTokenOriginSchema>

export const DesignTokenSchema = Type.Object({
  /** The real custom-property (or Tailwind theme key) name, e.g. `--color-aqua-100`. Never re-slugged, never a derived variant. */
  name: Type.String(),
  family: DesignTokenFamilySchema,
  /** Resolved light/default value, verbatim from source (already `var()`-resolved when the declaration was an alias). */
  value: Type.String(),
  /** Resolved value under the project's own recognised dark selector, when the source declares one and it genuinely differs from `value`. */
  darkValue: Type.Optional(Type.String()),
  origin: DesignTokenOriginSchema,
  /** Grouping label for the picker — the token's own naming-convention prefix (`color`, `space`, …) or a Tailwind theme key. */
  category: Type.Optional(Type.String()),
  /** The value converted to px, for `space`/`font-size`/`radius` families whose unit is resolvable. `undefined` (not present), never a guessed number, when the unit can't be converted (`%`, `vh`, a multi-part shorthand, …). */
  px: Type.Optional(Type.Number()),
  /** The `--other` name this token's raw declaration referenced, when the source value was `var(--other)` — the alias chain is otherwise lost once `value` holds the resolved leaf. */
  aliasOf: Type.Optional(Type.String()),
})
export type DesignToken = Static<typeof DesignTokenSchema>

/**
 * `{ file, selector }` naming ONE stylesheet + rule a NEW token declaration
 * can land in — the write-path half of the audit (T7), not built by this
 * pass (see the Track H handoff for what remains). `null` when the project
 * has no writable token stylesheet at all, in which case "New token" in the
 * picker renders disabled with this reason rather than silently doing
 * nothing.
 */
export const DesignTokenWriteTargetSchema = Type.Union([
  Type.Object({ file: Type.String(), selector: Type.String() }),
  Type.Null(),
])
export type DesignTokenWriteTarget = Static<typeof DesignTokenWriteTargetSchema>
