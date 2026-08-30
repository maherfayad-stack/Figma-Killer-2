/**
 * Studio MCP tools — the design-variable store's agent-facing surface:
 * `studio_ingest_design_variables`, `studio_list_design_variables`,
 * `studio_read_design_variable_set`, `studio_delete_design_variable_set`.
 * All `execution: 'server'`, headless — the store itself
 * (`designVariableStore.ts`) is plain filesystem state under
 * `.studio/variables/`.
 *
 * ## Studio never talks to Figma. This tool is where an agent hands over
 * what IT already fetched.
 *
 * `studio_measure_reference` infers a font size as a range and a colour by
 * sampling pixels because a raster is all it has. A design tool's own
 * variable API (Figma's `get_variable_defs`, most concretely) already states
 * those values exactly — but Studio's SERVER has no Figma connection and
 * never will inside this tool family. The connector, when configured, is
 * available to the AGENT (the `claude` subprocess), gated behind its own
 * three conditions. So the shape here is: the agent calls the design tool
 * itself, then calls `studio_ingest_design_variables` with whatever it got
 * back. **Every ingested table is stored and reported as what the agent was
 * given — Studio does not, and cannot, verify it against the design tool
 * itself.** Read that sentence again before trusting a `source` string: it is
 * free text the agent supplied, not a verified provenance chain.
 *
 * `studio_measure_reference` (which this family does NOT modify at the tool
 * level — see `referenceMeasure.ts`'s own wiring) consumes whatever has been
 * ingested automatically, matching each measured colour/size against the
 * design's own declared values and, from there, against the project's own
 * tokens — the three-way mapping described in that module's doc. When
 * nothing has been ingested, every one of those extra fields is simply
 * absent; nothing here changes `studio_measure_reference`'s existing
 * behaviour for a project that never calls these tools.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import {
  DESIGN_VARIABLE_LABEL_MAX_LENGTH,
  DESIGN_VARIABLE_NAME_MAX_LENGTH,
  DESIGN_VARIABLE_RAW_MAX_LENGTH,
  DESIGN_VARIABLE_SOURCE_MAX_LENGTH,
  DEFAULT_VARIABLES_PER_READ,
  DEFAULT_VARIABLE_SET_LIST_LIMIT,
  MAX_VARIABLES_PER_INGEST,
  MAX_VARIABLES_PER_READ,
  MAX_VARIABLE_SET_LIST_LIMIT,
} from '../../../../handlers/studio/designVariableSchema'
import {
  getDesignVariableSet,
  ingestDesignVariables,
  listDesignVariableSets,
  removeDesignVariableSet,
  type RawDesignVariableEntry,
} from '../../../../handlers/studio/designVariableStore'
import { getDesignReference } from '../../../../handlers/studio/designReferenceStore'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const DIR_INPUT_DESCRIPTION =
  'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.'

// ---------------------------------------------------------------------------
// studio_ingest_design_variables
// ---------------------------------------------------------------------------

const VariableEntrySchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: DESIGN_VARIABLE_NAME_MAX_LENGTH,
      description: 'The variable\'s own name, exactly as the design tool reported it — e.g. "coral/100", "spacing/md". Does not need to be a valid CSS identifier.',
    }),
    value: Type.Union(
      [
        Type.String({ minLength: 1, maxLength: DESIGN_VARIABLE_RAW_MAX_LENGTH }),
        Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
        Type.Boolean(),
      ],
      {
        description:
          'The variable\'s resolved value, exactly as the design tool reported it — a hex/rgb/hsl string for a colour, a number or numeric string for a FLOAT variable, or a boolean/string for anything else. Passed through verbatim into the stored "raw" value; Studio classifies it as a colour or a CSS px length by parsing this, never by trusting figmaType.',
      },
    ),
    figmaType: Type.Optional(
      Type.String({ maxLength: 40, description: 'The design tool\'s own type label for this variable, if known (e.g. Figma\'s COLOR/FLOAT/STRING/BOOLEAN). Stored for display only — never used to decide how the value is normalised.' }),
    ),
    collection: Type.Optional(
      Type.String({ maxLength: DESIGN_VARIABLE_LABEL_MAX_LENGTH, description: 'The variable collection this came from, if the design tool groups variables that way. Display-only.' }),
    ),
    mode: Type.Optional(
      Type.String({ maxLength: DESIGN_VARIABLE_LABEL_MAX_LENGTH, description: 'The collection mode this value belongs to, if any (e.g. "Light"). Display-only — this store has no dark/light concept of its own.' }),
    ),
  },
  { additionalProperties: false },
)

const IngestInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
    source: Type.String({
      minLength: 1,
      maxLength: DESIGN_VARIABLE_SOURCE_MAX_LENGTH,
      description:
        'Where this table came from, in your own words — e.g. "figma get_variable_defs on <file/node url>". Required, and shown back verbatim by every read tool: this is the ONE place a later reader (human or agent) can tell what was actually queried. Not verified by Studio.',
    }),
    pageId: Type.Optional(
      Type.String({ description: 'Scope this table to one Studio page id (from studio_list_pages), when the design it describes is for one screen. Omit when the table applies to the whole design file/project — most Figma variable tables do.' }),
    ),
    referenceId: Type.Optional(
      Type.String({ description: 'Scope this table to one already-registered design reference (studio_register_design_reference), when you are ingesting the variable table for the SAME design that reference is an image of. Must already exist — register the reference first.' }),
    ),
    label: Type.Optional(Type.String({ maxLength: DESIGN_VARIABLE_LABEL_MAX_LENGTH, description: 'A short human-readable name for this table, e.g. "Design system — Figma".' })),
    variables: Type.Array(VariableEntrySchema, {
      minItems: 1,
      maxItems: MAX_VARIABLES_PER_INGEST,
      description: `The name/value table as the design tool returned it. Up to ${MAX_VARIABLES_PER_INGEST} entries per call — call again for a larger table (each call creates its own addressable set).`,
    }),
  },
  { additionalProperties: false },
)

const ingestDesignVariablesTool: AiTool = {
  name: 'studio_ingest_design_variables',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Durably store a design\'s OWN declared variable table (e.g. from a Figma MCP connector\'s get_variable_defs) so studio_measure_reference can answer a measurement by LOOKUP instead of inferring it from pixels. Studio never fetches this itself — call the design tool yourself first, then pass what it returned here verbatim; this tool stores it as "what you were given", not something Studio independently verified. Each call creates one new, independently addressable set (studio_list_design_variables / studio_read_design_variable_set / studio_delete_design_variable_set). Colours (any CSS-recognisable hex/rgb/hsl string) and lengths with a knowable unit (px/rem/em/pt suffix, or a bare number — Figma\'s own convention for most FLOAT geometry variables, treated as px and flagged unitAssumed:true since a bare number could also be an opacity, a line-height multiplier, or a font-weight) are normalised for matching; anything else is stored as-is (kind:"other") and still readable, never dropped. Pass pageId and/or referenceId to scope the table to one screen/reference — omit both for a project-wide table, which is the right choice for most whole-file Figma exports. Duplicate names WITHIN one call are collapsed (last wins); duplicatesDropped in the result says how many.',
  inputSchema: IngestInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, source, pageId, referenceId, label, variables } = input as {
      dir?: string
      source: string
      pageId?: string
      referenceId?: string
      label?: string
      variables: Array<{
        name: string
        value: string | number | boolean
        figmaType?: string
        collection?: string
        mode?: string
      }>
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    if (referenceId !== undefined && !getDesignReference(dir, referenceId)) {
      return aiToolError(
        `No design reference "${referenceId}" is registered for this project — call studio_list_design_references to see what is, register it first with studio_register_design_reference, or omit referenceId to scope this table by pageId or project-wide instead.`,
      )
    }

    const entries: RawDesignVariableEntry[] = variables.map((v) => ({
      name: v.name,
      raw: typeof v.value === 'string' ? v.value : String(v.value),
      ...(v.figmaType ? { figmaType: v.figmaType } : {}),
      ...(v.collection ? { collection: v.collection } : {}),
      ...(v.mode ? { mode: v.mode } : {}),
    }))

    const result = ingestDesignVariables(dir, entries, { source, pageId, referenceId, label })

    return {
      ok: true,
      dir,
      set: {
        id: result.set.id,
        ingestedAt: result.set.ingestedAt,
        source: result.set.source,
        ...(result.set.pageId ? { pageId: result.set.pageId } : {}),
        ...(result.set.referenceId ? { referenceId: result.set.referenceId } : {}),
        ...(result.set.label ? { label: result.set.label } : {}),
        variableCount: result.set.variables.length,
      },
      duplicatesDropped: result.duplicatesDropped,
      colorCount: result.colorCount,
      sizeCount: result.sizeCount,
      otherCount: result.otherCount,
    }
  },
}

// ---------------------------------------------------------------------------
// studio_list_design_variables
// ---------------------------------------------------------------------------

const ListInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
    pageId: Type.Optional(Type.String({ description: 'Restrict to sets scoped to one Studio page id.' })),
    referenceId: Type.Optional(Type.String({ description: 'Restrict to sets scoped to one design reference id.' })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_VARIABLE_SET_LIST_LIMIT, description: `Cap on returned sets. Default ${DEFAULT_VARIABLE_SET_LIST_LIMIT}.` }),
    ),
  },
  { additionalProperties: false },
)

const listDesignVariablesTool: AiTool = {
  name: 'studio_list_design_variables',
  scope: 'shared',
  execution: 'server',
  description:
    'List design-variable sets ingested for this project (studio_ingest_design_variables). Each entry is a SUMMARY (id, ingestedAt, source, pageId?, referenceId?, label?, variableCount, colorCount, sizeCount, otherCount) — call studio_read_design_variable_set for the actual name/value entries. Pass pageId or referenceId to restrict to sets scoped to one screen/reference; omit both to see everything, including project-wide sets. An empty result means no design-variable table has been ingested — studio_measure_reference is then operating on pixel measurement alone, exactly as it always has.',
  inputSchema: ListInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pageId, referenceId, limit } = input as {
      dir?: string
      pageId?: string
      referenceId?: string
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = listDesignVariableSets(dir, { pageId, referenceId }, limit)
    return {
      ok: true,
      dir,
      totalCount: result.totalCount,
      returnedCount: result.sets.length,
      truncated: result.truncated,
      ...(result.truncated ? { omittedCount: result.omittedCount } : {}),
      sets: result.sets,
    }
  },
}

// ---------------------------------------------------------------------------
// studio_read_design_variable_set
// ---------------------------------------------------------------------------

const ReadSetInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
    setId: Type.String({ minLength: 1, description: 'A studio_ingest_design_variables set id (from its own result or studio_list_design_variables).' }),
    nameContains: Type.Optional(
      Type.String({ minLength: 1, maxLength: DESIGN_VARIABLE_NAME_MAX_LENGTH, description: 'Case-insensitive substring filter on variable name, e.g. "coral" or "spacing/". Omit to see all of them (subject to limit).' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_VARIABLES_PER_READ, description: `Cap on returned variables. Default ${DEFAULT_VARIABLES_PER_READ}.` }),
    ),
  },
  { additionalProperties: false },
)

const readDesignVariableSetTool: AiTool = {
  name: 'studio_read_design_variable_set',
  scope: 'shared',
  execution: 'server',
  description:
    'Read one ingested design-variable set\'s actual name/value entries by id. Each entry reports the ORIGINAL authored value (raw) alongside how Studio normalised it: kind ("color"/"size"/"other"), hex (colours) or px (sizes, with unitAssumed:true when a bare unit-less number was treated as px). Capped (default 200, max 500) with an honest truncated/omittedCount — use nameContains to narrow a large table instead of paging through it blind. Returns ok:false with a clear reason for an unknown set id.',
  inputSchema: ReadSetInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, setId, nameContains, limit } = input as {
      dir?: string
      setId: string
      nameContains?: string
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const set = getDesignVariableSet(dir, setId)
    if (!set) {
      return aiToolError(`No design-variable set "${setId}" found for this project — call studio_list_design_variables to see what is ingested.`)
    }

    const needle = nameContains?.toLowerCase()
    const filtered = needle ? set.variables.filter((v) => v.name.toLowerCase().includes(needle)) : set.variables
    const cap = Math.max(1, Math.min(limit ?? DEFAULT_VARIABLES_PER_READ, MAX_VARIABLES_PER_READ))
    const shown = filtered.slice(0, cap)

    return {
      ok: true,
      dir,
      set: {
        id: set.id,
        ingestedAt: set.ingestedAt,
        source: set.source,
        ...(set.pageId ? { pageId: set.pageId } : {}),
        ...(set.referenceId ? { referenceId: set.referenceId } : {}),
        ...(set.label ? { label: set.label } : {}),
      },
      totalCount: filtered.length,
      returnedCount: shown.length,
      truncated: filtered.length > shown.length,
      ...(filtered.length > shown.length ? { omittedCount: filtered.length - shown.length } : {}),
      variables: shown,
    }
  },
}

// ---------------------------------------------------------------------------
// studio_delete_design_variable_set
// ---------------------------------------------------------------------------

const DeleteSetInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
    setId: Type.String({ minLength: 1, description: 'A studio_ingest_design_variables set id to remove. Removing an unknown or already-removed id is not an error.' }),
  },
  { additionalProperties: false },
)

const deleteDesignVariableSetTool: AiTool = {
  name: 'studio_delete_design_variable_set',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Remove one ingested design-variable set by id. Idempotent — removing an unknown or already-removed id still returns { ok: true, removed: false }, never an error. Requires studio.write.',
  inputSchema: DeleteSetInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, setId } = input as { dir?: string; setId: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const result = removeDesignVariableSet(dir, setId)
    return { ok: true, dir, removed: result.removed }
  },
}

export const studioDesignVariableMcpTools: AiTool[] = [
  ingestDesignVariablesTool,
  listDesignVariablesTool,
  readDesignVariableSetTool,
  deleteDesignVariableSetTool,
]
