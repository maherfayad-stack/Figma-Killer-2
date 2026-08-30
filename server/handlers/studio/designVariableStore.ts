/**
 * designVariableStore — a durable, per-project store for a design's OWN
 * declared variable table (typically Figma's `get_variable_defs`), so a
 * measurement can be settled by lookup instead of pixel archaeology.
 *
 * ## Why this exists, and why Studio does not fetch it itself
 *
 * `studio_measure_reference` infers a font size as a RANGE and a colour by
 * sampling pixels, because a raster is all it has. A design tool that
 * exposes its own variable table (Figma's MCP `get_variable_defs`, most
 * concretely) already states those values exactly. Studio's SERVER never
 * talks to Figma — the Figma connector, when configured, is available to the
 * AGENT (the `claude` subprocess), gated behind its own three conditions
 * (`docs/features/agent.md`). So the only correct shape is: the agent calls
 * the design tool itself and hands the resulting table to Studio to persist
 * and use. Every consumer of what this store returns must therefore treat it
 * as **what the agent was given, never something Studio independently
 * verified** — see `designVariableSchema.ts`'s module doc and every tool
 * description in `server/ai/mcp/tools/studio/designVariableTools.ts`.
 *
 * ## Where it lives
 *
 * `.studio/variables/`, a sibling of `.studio/references/` — same
 * durability class (survives across chat turns/restarts on the running
 * server's disk, not across a git clone; `.gitignore` excludes it for the
 * same reason: this is user-supplied intent, not disposable build output,
 * but a real project's variable table can run into the hundreds of entries
 * and is cheap to lose since the agent re-fetches it from the design tool on
 * request). Plain JSON, no image bytes, so unlike `designReferenceStore.ts`
 * there is no `assetLanding.ts` write path to share — this is a manifest
 * store the same shape as `.studio/boards.json`/`.studio/meta.json`.
 *
 * ## Cardinality — many sets per project, each independently scoped
 *
 * A set is associated with the PROJECT always, and optionally with one
 * Studio `pageId` and/or one registered design `referenceId` — never
 * required to have either. A real Figma variable table usually describes an
 * entire design file, not one screen, so forcing every ingested table onto a
 * single page or a single reference would be wrong far more often than it
 * would be right. `resolveApplicableDesignVariableSets` (below) is what
 * turns "many sets, each scoped however the agent scoped it" into "the ones
 * that apply to THIS measurement".
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import {
  DesignVariableManifestSchema,
  EMPTY_DESIGN_VARIABLE_MANIFEST,
  MAX_VARIABLES_PER_INGEST,
  type DesignVariable,
  type DesignVariableManifest,
  type DesignVariableSet,
} from './designVariableSchema'
import { normalizeDesignVariableValue } from './designVariableNormalize'

const SET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function variablesDir(dir: string): string {
  return join(dir, '.studio', 'variables')
}

function manifestFile(dir: string): string {
  return join(variablesDir(dir), 'manifest.json')
}

function readManifest(dir: string): DesignVariableManifest {
  const file = manifestFile(dir)
  if (!existsSync(file)) return EMPTY_DESIGN_VARIABLE_MANIFEST
  const raw = readFileSync(file, 'utf8')
  return parseJsonWithFallback(raw, DesignVariableManifestSchema, EMPTY_DESIGN_VARIABLE_MANIFEST)
}

function writeManifest(dir: string, manifest: DesignVariableManifest): void {
  const file = manifestFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(manifest, null, 2))
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** One entry as the ingestion tool receives it — already boundary-validated by its TypeBox `inputSchema` (string lengths, array length) before this runs. */
export interface RawDesignVariableEntry {
  readonly name: string
  readonly raw: string
  readonly figmaType?: string
  readonly collection?: string
  readonly mode?: string
}

export interface IngestDesignVariablesMeta {
  readonly source: string
  readonly pageId?: string
  readonly referenceId?: string
  readonly label?: string
}

export interface IngestDesignVariablesResult {
  readonly set: DesignVariableSet
  /** Count of input entries dropped because their `name` repeated an earlier entry in the SAME ingest call — last occurrence wins. Never silent: always returned, even when zero. */
  readonly duplicatesDropped: number
  readonly colorCount: number
  readonly sizeCount: number
  readonly otherCount: number
}

/**
 * Normalise and persist one design-variable table as a new set. Never
 * throws on a malformed VALUE — an entry that normalises to `'other'` is
 * still stored (raw preserved, `hex`/`px` simply absent), because "this
 * design variable isn't a colour or a knowable length" is itself useful
 * information (it might be a font-weight, a boolean, free text) and
 * discarding it would silently narrow what a later reader can see.
 *
 * Duplicate `name`s within ONE ingest call are collapsed, last wins — the
 * same "last declaration wins" rule `buildProjectTokenIndex` applies to two
 * `:root` blocks that redeclare a property, so a caller re-sending an
 * updated table under the same names behaves the way editing a stylesheet
 * would. Cross-SET duplicates (the same name in two different ingest calls)
 * are NOT deduplicated — each set is its own addressable, independently
 * removable table; see `resolveApplicableDesignVariableSets` for how
 * multiple applicable sets are merged at READ time instead.
 */
export function ingestDesignVariables(
  dir: string,
  entries: readonly RawDesignVariableEntry[],
  meta: IngestDesignVariablesMeta,
): IngestDesignVariablesResult {
  const capped = entries.slice(0, MAX_VARIABLES_PER_INGEST)

  const byName = new Map<string, DesignVariable>()
  for (const entry of capped) {
    const normalized = normalizeDesignVariableValue(entry.raw)
    const variable: DesignVariable = {
      name: entry.name,
      raw: entry.raw,
      kind: normalized.kind,
      ...(normalized.hex ? { hex: normalized.hex } : {}),
      ...(normalized.px !== undefined ? { px: normalized.px } : {}),
      ...(normalized.unitAssumed ? { unitAssumed: true } : {}),
      ...(entry.figmaType ? { figmaType: entry.figmaType } : {}),
      ...(entry.collection ? { collection: entry.collection } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
    }
    byName.set(entry.name, variable)
  }
  const duplicatesDropped = capped.length - byName.size

  const variables = [...byName.values()]
  const colorCount = variables.filter((v) => v.kind === 'color').length
  const sizeCount = variables.filter((v) => v.kind === 'size').length
  const otherCount = variables.length - colorCount - sizeCount

  const set: DesignVariableSet = {
    id: randomUUID(),
    ingestedAt: new Date().toISOString(),
    source: meta.source,
    ...(meta.pageId ? { pageId: meta.pageId } : {}),
    ...(meta.referenceId ? { referenceId: meta.referenceId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
    variables,
  }

  const manifest = readManifest(dir)
  writeManifest(dir, { ...manifest, sets: [...manifest.sets, set] })

  return { set, duplicatesDropped, colorCount, sizeCount, otherCount }
}

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

const DEFAULT_SET_LIST_LIMIT = 50
const MAX_SET_LIST_LIMIT = 200

export interface DesignVariableSetSummary {
  readonly id: string
  readonly ingestedAt: string
  readonly source: string
  readonly pageId?: string
  readonly referenceId?: string
  readonly label?: string
  readonly variableCount: number
  readonly colorCount: number
  readonly sizeCount: number
  readonly otherCount: number
}

function summarize(set: DesignVariableSet): DesignVariableSetSummary {
  const colorCount = set.variables.filter((v) => v.kind === 'color').length
  const sizeCount = set.variables.filter((v) => v.kind === 'size').length
  return {
    id: set.id,
    ingestedAt: set.ingestedAt,
    source: set.source,
    ...(set.pageId ? { pageId: set.pageId } : {}),
    ...(set.referenceId ? { referenceId: set.referenceId } : {}),
    ...(set.label ? { label: set.label } : {}),
    variableCount: set.variables.length,
    colorCount,
    sizeCount,
    otherCount: set.variables.length - colorCount - sizeCount,
  }
}

export interface ListDesignVariableSetsResult {
  readonly sets: readonly DesignVariableSetSummary[]
  readonly totalCount: number
  readonly truncated: boolean
  readonly omittedCount: number
}

/** Summaries only — never the full variable arrays, which can legitimately run into the hundreds per set. Call `getDesignVariableSet` for one set's contents. Capped, never a silent drop. */
export function listDesignVariableSets(
  dir: string,
  filter: { readonly pageId?: string; readonly referenceId?: string },
  limit: number | undefined,
): ListDesignVariableSetsResult {
  const all = readManifest(dir).sets.filter(
    (s) => (!filter.pageId || s.pageId === filter.pageId) && (!filter.referenceId || s.referenceId === filter.referenceId),
  )
  const cap = Math.max(1, Math.min(limit ?? DEFAULT_SET_LIST_LIMIT, MAX_SET_LIST_LIMIT))
  const shown = all.slice(0, cap)
  return {
    sets: shown.map(summarize),
    totalCount: all.length,
    truncated: all.length > shown.length,
    omittedCount: all.length - shown.length,
  }
}

export function getDesignVariableSet(dir: string, setId: string): DesignVariableSet | null {
  if (!SET_ID_PATTERN.test(setId)) return null
  return readManifest(dir).sets.find((s) => s.id === setId) ?? null
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export interface RemoveDesignVariableSetResult {
  readonly removed: boolean
}

/** Idempotent — an unknown or already-removed id returns `{ removed: false }`, never an error. Same contract as `removeDesignReference`. */
export function removeDesignVariableSet(dir: string, setId: string): RemoveDesignVariableSetResult {
  const manifest = readManifest(dir)
  if (!manifest.sets.some((s) => s.id === setId)) return { removed: false }
  writeManifest(dir, { ...manifest, sets: manifest.sets.filter((s) => s.id !== setId) })
  return { removed: true }
}

// ---------------------------------------------------------------------------
// Resolution — which sets apply to a given measurement
// ---------------------------------------------------------------------------

/**
 * The sets relevant to measuring `pageId` (optionally scoped further by
 * `referenceId`, the design reference actually being measured against):
 * every project-wide set (neither `pageId` nor `referenceId`), every set
 * scoped to THIS page, and every set scoped to THIS reference. A set scoped
 * to a DIFFERENT page or a different reference never applies here — scoping
 * is exclusionary, not just a suggestion.
 *
 * Ordered least- to most-specific (project-wide, then page-scoped, then
 * reference-scoped). `buildDesignVariableIndex`'s nearest-value search does
 * not need this for correctness (every entry participates in the distance
 * search on its own merits, tagged with its own set/source for provenance),
 * but on an exact tie it prefers the LATER — i.e. more specific — entry, so
 * a colour a reference-scoped table and the project-wide table both define
 * identically resolves to the reference's own name rather than an
 * unrelated project-wide one.
 */
export function resolveApplicableDesignVariableSets(
  dir: string,
  pageId: string,
  referenceId: string | undefined,
): DesignVariableSet[] {
  const all = readManifest(dir).sets
  const projectWide = all.filter((s) => !s.pageId && !s.referenceId)
  const pageScoped = all.filter((s) => s.pageId === pageId)
  const referenceScoped = referenceId ? all.filter((s) => s.referenceId === referenceId) : []
  return [...projectWide, ...pageScoped, ...referenceScoped]
}
