/**
 * packageManifestSchema — the wire shape produced by `packageManifest.ts`'s
 * static `.d.ts`/`.tsx` extraction: a pure schema leaf (TypeBox schemas +
 * their derived types, nothing else), matching the arrangement
 * `projectProfileSchema.ts` uses and for the same reason — keeps the module
 * graph one-directional, no cycle between the schema and the module that
 * produces it (see that file's doc comment for the full rationale).
 *
 * `PropKind` is the payoff of WS-3.1 (`STUDIO-IMPORT-V2-PLAN.md`): one
 * classification of a component prop's TYPE that drives every
 * Properties-panel control choice downstream — a dropdown from `enum`, a
 * color picker from `color`, an image picker from `image`, a slot from
 * `node` (WS-3.4, not this slice). `packageManifest.ts` is the only producer;
 * `componentBundle.ts` is the only consumer this slice ships.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const PropKindSchema = Type.Union([
  Type.Object({ kind: Type.Literal('string') }),
  Type.Object({ kind: Type.Literal('number') }),
  Type.Object({ kind: Type.Literal('boolean') }),
  /** A string-literal union (`variant?: 'primary' | 'ghost'`) — the Properties panel renders this as a `select`. */
  Type.Object({ kind: Type.Literal('enum'), values: Type.Array(Type.String()) }),
  /** A `string` prop whose NAME matches `/color|fill|stroke|bg/i` — see `packageManifest.ts`'s `classifyPropType`. */
  Type.Object({ kind: Type.Literal('color') }),
  /** A `string` prop whose NAME matches `/src|image|icon|avatar|logo/i`. */
  Type.Object({ kind: Type.Literal('image') }),
  /** `ReactNode` / `ReactElement` / `JSX.Element` — a slot, not a scalar control (WS-3.4 renders it; this slice only classifies it). */
  Type.Object({ kind: Type.Literal('node') }),
  /**
   * A function-typed prop (`(e: MouseEvent) => void`). Classified so the
   * extractor can recognize it, then DROPPED before it ever reaches a
   * `ComponentSpec` — never stubbed. This is today's rule (see
   * `src/modules/alm/register.tsx`'s doc comment), kept, not reinvented.
   */
  Type.Object({ kind: Type.Literal('handler') }),
  /** Every other shape — an object type, a generic this extractor doesn't unwrap, an unresolvable reference. */
  Type.Object({ kind: Type.Literal('unknown') }),
])
export type PropKind = Static<typeof PropKindSchema>

export const PropSpecSchema = Type.Object({
  name: Type.String(),
  kind: PropKindSchema,
  required: Type.Boolean(),
})
export type PropSpec = Static<typeof PropSpecSchema>

export const ComponentSpecSchema = Type.Object({
  /** Display name — the export's own name, never the literal `'default'`; see `packageManifest.ts` for how a default export's real name is recovered. */
  name: Type.String(),
  /** POSIX path to the file the export was found in, relative to the PACKAGE root (not the workspace) — e.g. `dist/index.d.ts`. */
  file: Type.String(),
  /** The literal export name at `file` — `'default'` for a default export, otherwise identical to `name`. */
  exportName: Type.String(),
  isDefaultExport: Type.Boolean(),
  props: Type.Array(PropSpecSchema),
})
export type ComponentSpec = Static<typeof ComponentSpecSchema>
