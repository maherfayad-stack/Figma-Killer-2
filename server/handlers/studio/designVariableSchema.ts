/**
 * designVariableSchema — the persisted shape of one entry in
 * `.studio/variables/manifest.json` (see `designVariableStore.ts`).
 *
 * A "design variable" here means: a name/value pair an AGENT read out of a
 * design tool's own variable table (Figma's `get_variable_defs` is the
 * motivating case — see `docs/features/mcp-connectors.md`'s "Design
 * references" section and this feature's own module docs for the full
 * reasoning) and handed to Studio to persist. **Studio never talks to Figma
 * itself** — the agent calls the design tool, Studio only stores and indexes
 * whatever the agent reported. Every consumer of this data must therefore
 * treat it as "what the agent was given", never as something Studio
 * independently verified against the design tool.
 *
 * Kept as its own schema leaf, the same split `designReferenceSchema.ts`
 * uses relative to `designReferenceStore.ts`: the store both reads and
 * writes this shape, so it can't live inside the store module without
 * becoming a self-import.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/** How a variable's authored value normalised. `'other'` covers anything that is not a recognisable CSS colour or a length with a knowable unit — a font-weight, an opacity, a boolean, free text. */
export const DESIGN_VARIABLE_KINDS = ['color', 'size', 'other'] as const
export type DesignVariableKind = (typeof DESIGN_VARIABLE_KINDS)[number]

const DesignVariableKindSchema = Type.Union(DESIGN_VARIABLE_KINDS.map((kind) => Type.Literal(kind)))

/** Bounds applied at the MCP input boundary (`designVariableTools.ts`) — re-declared here as the ceiling the STORED shape itself enforces, so a hand-edited manifest can't smuggle in something the ingestion boundary would have refused. */
export const DESIGN_VARIABLE_NAME_MAX_LENGTH = 300
export const DESIGN_VARIABLE_RAW_MAX_LENGTH = 1000
export const DESIGN_VARIABLE_SOURCE_MAX_LENGTH = 500
export const DESIGN_VARIABLE_LABEL_MAX_LENGTH = 200
export const MAX_VARIABLES_PER_INGEST = 1000
/** Read-side cap for `studio_read_design_variable_set` — independent of the ingest cap so a manifest that grew across several calls (each individually under `MAX_VARIABLES_PER_INGEST`) still can't produce an unbounded single response. */
export const MAX_VARIABLES_PER_READ = 500
export const DEFAULT_VARIABLES_PER_READ = 200
export const DEFAULT_VARIABLE_SET_LIST_LIMIT = 50
export const MAX_VARIABLE_SET_LIST_LIMIT = 200

export const DesignVariableSchema = Type.Object({
  /** As reported by the design tool, e.g. "coral/100" or "spacing/md". Not required to be a valid CSS identifier — Figma variable names routinely contain `/`. */
  name: Type.String({ minLength: 1, maxLength: DESIGN_VARIABLE_NAME_MAX_LENGTH }),
  /** The value exactly as the agent supplied it (already stringified), e.g. "#EF4550", "16", "1.5rem". Never discarded even when normalisation fails. */
  raw: Type.String({ minLength: 1, maxLength: DESIGN_VARIABLE_RAW_MAX_LENGTH }),
  kind: DesignVariableKindSchema,
  /** Present only when `kind === 'color'` — canonical lowercase 6-digit hex. */
  hex: Type.Optional(Type.String({ minLength: 7, maxLength: 7 })),
  /** Present only when `kind === 'size'` — canonical CSS px. */
  px: Type.Optional(Type.Number()),
  /** True when `px` was derived by treating a bare, unit-less number as px (Figma's own convention for most FLOAT geometry variables) rather than from an explicit `px`/`rem`/`em`/`pt` suffix in `raw`. A consumer that wants only unit-certain matches should skip entries where this is true. */
  unitAssumed: Type.Optional(Type.Boolean()),
  /** The design tool's own type label for this variable, if the agent reported one (e.g. Figma's `COLOR`/`FLOAT`/`STRING`/`BOOLEAN`). Purely informational — normalisation above is derived from `raw` alone, never trusted from this field, since a caller could mislabel it. */
  figmaType: Type.Optional(Type.String({ maxLength: 40 })),
  /** The variable collection this came from, if reported (Figma groups variables into named collections). Display-only. */
  collection: Type.Optional(Type.String({ maxLength: DESIGN_VARIABLE_LABEL_MAX_LENGTH })),
  /** The collection mode this value belongs to, if reported (e.g. "Light", "Default"). Display-only — this store has no dark/light concept of its own, matching `projectTokenIndex`'s "only light values are indexed" stance. */
  mode: Type.Optional(Type.String({ maxLength: DESIGN_VARIABLE_LABEL_MAX_LENGTH })),
})
export type DesignVariable = Static<typeof DesignVariableSchema>

export const DesignVariableSetSchema = Type.Object({
  /** UUID v4, generated at ingestion — the address every tool uses. */
  id: Type.String({ minLength: 1 }),
  ingestedAt: Type.String({ minLength: 1 }),
  /** Free-form provenance the agent supplied, e.g. "figma get_variable_defs on <file/node url>". Not verified by Studio — see module doc. */
  source: Type.String({ minLength: 1, maxLength: DESIGN_VARIABLE_SOURCE_MAX_LENGTH }),
  /** Scopes this set to one Studio page, when the agent supplied one. Optional — a design's variable table often applies to the whole file, not one screen. */
  pageId: Type.Optional(Type.String({ minLength: 1 })),
  /** Scopes this set to one registered design reference, when the agent supplied one — e.g. "this is the variable table for the same Figma frame I registered as reference X". Optional and independent of `pageId`: a set can carry either, both, or neither (project-wide). */
  referenceId: Type.Optional(Type.String({ minLength: 1 })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: DESIGN_VARIABLE_LABEL_MAX_LENGTH })),
  variables: Type.Array(DesignVariableSchema, { maxItems: MAX_VARIABLES_PER_INGEST }),
})
export type DesignVariableSet = Static<typeof DesignVariableSetSchema>

export const DesignVariableManifestSchema = Type.Object({
  version: Type.Literal(1),
  sets: Type.Array(DesignVariableSetSchema),
})
export type DesignVariableManifest = Static<typeof DesignVariableManifestSchema>

export const EMPTY_DESIGN_VARIABLE_MANIFEST: DesignVariableManifest = { version: 1, sets: [] }
