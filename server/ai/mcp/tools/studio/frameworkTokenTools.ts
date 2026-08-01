/**
 * Reading a project's design tokens without reading the store they live in.
 *
 * `.studio/framework.json` is Studio's own generated token store, and it is
 * enormous: 97 KB / ~36,200 tokens in a real project, which is well past the
 * CLI `Read` tool's 25,000-token ceiling. Agents kept trying to read it whole
 * and kept failing — the same failure, in the parent turn AND again inside each
 * subagent, because nothing is shared between them.
 *
 * The size is not waste to be trimmed. It is 226 colour tokens at ~420 bytes
 * each, because every token carries its full editor configuration: `id`,
 * `createdAt`, `updatedAt`, `generateUtilities`, `generateTransparent`,
 * `generateShades`, `generateTints`, `order`. All of that matters to the
 * framework engine. **None of it matters to an agent choosing a colour**, which
 * needs a name and a value.
 *
 * So this projects rather than truncates: `slug` + the resolved value, and the
 * dark value only when the token actually has one. ~40 bytes per token instead
 * of ~420 — the full palette lands near 2.5k tokens instead of 36k, and a
 * filtered query far below that.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import type { AiTool } from '../../../runtime/types'
import { resolveProjectDir } from '../../../../handlers/studioProjects'

/** Bounded so a pathological project cannot blow the turn; well above any real palette. */
const MAX_RETURNED = 400

/**
 * Deliberately loose: this reads a file the framework engine owns and evolves,
 * and a schema mismatch here must degrade to "no tokens reported", never fail
 * a chat turn. Only the fields being projected are modelled.
 */
const ColorTokenSchema = Type.Object({
  slug: Type.Optional(Type.String()),
  lightValue: Type.Optional(Type.String()),
  darkValue: Type.Optional(Type.String()),
  darkModeEnabled: Type.Optional(Type.Boolean()),
  category: Type.Optional(Type.String()),
}, { additionalProperties: true })

const ScaleGroupSchema = Type.Object({
  name: Type.Optional(Type.String()),
  namingConvention: Type.Optional(Type.String()),
  steps: Type.Optional(Type.String()),
}, { additionalProperties: true })

const FrameworkSchema = Type.Object({
  colors: Type.Optional(Type.Object({
    tokens: Type.Optional(Type.Array(ColorTokenSchema)),
  }, { additionalProperties: true })),
  typography: Type.Optional(Type.Object({
    groups: Type.Optional(Type.Array(ScaleGroupSchema)),
  }, { additionalProperties: true })),
  spacing: Type.Optional(Type.Object({
    groups: Type.Optional(Type.Array(ScaleGroupSchema)),
  }, { additionalProperties: true })),
}, { additionalProperties: true })

const TokensInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
    ),
    filter: Type.Optional(
      Type.String({ description: 'Case-insensitive substring match on the token name, e.g. "brand" or "text".' }),
    ),
  },
  { additionalProperties: false },
)

const tokensTool: AiTool = {
  name: 'studio_list_tokens',
  scope: 'shared',
  execution: 'server',
  description:
    'List this project\'s design tokens — colour names with their light/dark values, plus the typography and spacing scales. USE THIS INSTEAD OF READING .studio/framework.json, which is a generated store around 100 KB and always fails the read-size limit. Pass filter to narrow by name ("brand", "text", "surface"). Returns names and values only, never the editor configuration around them.',
  inputSchema: TokensInputSchema,
  handler: async (input) => {
    const { dir: dirInput, filter } = input as { dir?: string; filter?: string }
    const dir = resolveProjectDir(dirInput)
    const file = join(dir, '.studio', 'framework.json')
    if (!existsSync(file)) {
      return { ok: true, dir, colors: [], typography: [], spacing: [], note: 'This project has no design tokens configured yet.' }
    }

    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, error: `Could not read this project's tokens: ${err instanceof Error ? err.message : String(err)}` }
    }

    const framework = parseJsonWithFallback(raw, FrameworkSchema, {})
    const needle = filter?.trim().toLowerCase() ?? ''

    const allColors = framework.colors?.tokens ?? []
    const matched = allColors.filter((token) => {
      if (!token.slug) return false
      return needle.length === 0 || token.slug.toLowerCase().includes(needle)
    })
    const colors = matched.slice(0, MAX_RETURNED).map((token) => ({
      name: token.slug!,
      value: token.lightValue ?? '',
      // Only when the token genuinely has a distinct dark value — emitting a
      // duplicate for every token would double the payload for no information.
      ...(token.darkModeEnabled && token.darkValue && token.darkValue !== token.lightValue
        ? { dark: token.darkValue }
        : {}),
    }))

    const scale = (groups: Array<{ name?: string; namingConvention?: string; steps?: string }> | undefined) =>
      (groups ?? []).map((group) => ({
        name: group.name ?? '(unnamed)',
        naming: group.namingConvention ?? '',
        steps: group.steps ?? '',
      }))

    return {
      ok: true,
      dir,
      colorCount: allColors.length,
      ...(matched.length > colors.length ? { truncated: true, shown: colors.length } : {}),
      colors,
      typography: scale(framework.typography?.groups),
      spacing: scale(framework.spacing?.groups),
    }
  },
}

export const studioFrameworkTokenMcpTools: AiTool[] = [tokensTool]
