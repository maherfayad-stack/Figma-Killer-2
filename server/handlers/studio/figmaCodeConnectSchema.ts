/**
 * figmaCodeConnectSchema — the wire shape `figmaCodeConnect.ts`'s static
 * `*.figma.tsx` extraction produces: a pure schema leaf (TypeBox schemas +
 * their derived types, nothing else), matching the arrangement
 * `packageManifestSchema.ts` uses and for the same reason — keeps the module
 * graph one-directional, no cycle between the schema and the module that
 * produces it (see that file's own doc comment for the full rationale).
 *
 * Deliberately a SEPARATE shape from `packageManifestSchema.ts`'s
 * `ComponentSpec`/`PropSpec`, not a reuse of it — a Code Connect mapping
 * carries fields a `.d.ts` extraction has no equivalent for (a Figma node
 * URL, a Figma-side property/variant name, an enum's real Figma LABELS
 * alongside its code values, a verification note) and is missing one a
 * `.d.ts` extraction always has (a `required` flag — Code Connect maps
 * VALUES a variant can take, not whether a prop must be supplied). Collapsing
 * the two into one shape would either invent a fake `required` or silently
 * drop the Figma-only fields; callers that fold both sources together
 * (`studio_list_components`) keep them as distinctly-tagged sibling data
 * instead — see that tool's own `apiSource` discriminant.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const FigmaCodeConnectPropKindSchema = Type.Union([
  Type.Literal('string'),
  Type.Literal('boolean'),
  Type.Literal('enum'),
  /** A `props` entry whose value isn't one of `figma.enum`/`figma.string`/`figma.boolean` — classified as unrecognized rather than guessed or dropped. */
  Type.Literal('unknown'),
])
export type FigmaCodeConnectPropKind = Static<typeof FigmaCodeConnectPropKindSchema>

/** One `figma.enum(...)` entry: the Figma-side variant label and the real code-side value it resolves to (a string, a boolean — `figma.enum('Switch', { on: true, off: false })` — or a number). */
export const FigmaEnumMappingEntrySchema = Type.Object({
  figmaValue: Type.String(),
  codeValue: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
  /** A same-line trailing comment on this mapping entry, e.g. `// (approx) Figma models disabled as a Type; code uses the disabled attr`. Absent when the entry carries no inline note. */
  note: Type.Optional(Type.String()),
})
export type FigmaEnumMappingEntry = Static<typeof FigmaEnumMappingEntrySchema>

export const FigmaCodeConnectPropSchema = Type.Object({
  /** The CODE-facing prop name — the key in `figma.connect`'s `props` object, e.g. `variant`. */
  name: Type.String(),
  /** The FIGMA-facing property/variant name being mapped, e.g. `'Type'`. */
  figmaProperty: Type.String(),
  kind: FigmaCodeConnectPropKindSchema,
  /** Present for `kind: 'enum'` only — every Figma label -> code value pair, in source order. */
  mapping: Type.Optional(Type.Array(FigmaEnumMappingEntrySchema)),
  /** A leading comment directly above this prop's mapping line, when present (general context, not per-value — see `mapping[].note` for that). */
  note: Type.Optional(Type.String()),
})
export type FigmaCodeConnectProp = Static<typeof FigmaCodeConnectPropSchema>

export const FigmaCodeConnectComponentSchema = Type.Object({
  /** The identifier passed as `figma.connect`'s first argument — the component's own exported name in ordinary use. */
  component: Type.String(),
  /** POSIX path to the `*.figma.tsx` mapping file, relative to the PACKAGE root (not the workspace) — e.g. `src/components/Button.figma.tsx`. */
  file: Type.String(),
  /** The literal Figma URL passed as `figma.connect`'s second argument. */
  figmaUrl: Type.String(),
  /** Parsed from `figmaUrl`'s `/design/<fileKey>/` segment. Absent only when the URL doesn't match the expected Figma design-file shape at all. */
  figmaFileKey: Type.Optional(Type.String()),
  /** Parsed from `figmaUrl`'s `node-id` query param, normalized from the URL's dash form (`53958-5861`) to Figma's own colon form (`53958:5861`) when it has that shape. Absent when the URL has no `node-id` param at all. */
  figmaNodeId: Type.Optional(Type.String()),
  /** `true` when `figmaNodeId` does not look like a real Figma node id (e.g. an un-filled-in `REPLACE-ME` template from `figma connect create`, or any other non-numeric value) — a caller must not treat it as a resolvable Figma reference. */
  nodeIdPlaceholder: Type.Boolean(),
  /** The file's own leading comment block (before the first import) — typically "verified against Figma node X" / "STRUCTURAL DIVERGENCE" prose recording provenance and known caveats. */
  verifiedNote: Type.Optional(Type.String()),
  props: Type.Array(FigmaCodeConnectPropSchema),
  /** The source text of `figma.connect`'s `example` function — a canonical, real-JSX usage example, verbatim. Absent only when the file has no `example` field at all. */
  example: Type.Optional(Type.String()),
})
export type FigmaCodeConnectComponent = Static<typeof FigmaCodeConnectComponentSchema>
