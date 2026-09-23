/**
 * `studio_list_tokens` — the project's design tokens, read from the CSS the
 * canvas actually loads.
 *
 * ## What it used to read, and why that was a lie (AI-4)
 *
 * This tool read `.studio/framework.json` — Studio's OWN generated framework
 * scale, which `projectTokenIndex.ts` explicitly refuses to treat as the
 * project's design system. On every real project that store is
 * `{"colors":{"tokens":[]}}`, so the tool answered every agent with an empty
 * palette while the system prompt called it the source of "every --type-*
 * value". An agent told "this project has no tokens" writes raw hex, and the
 * quality check then flags every one of them.
 *
 * It now reads what every other token reader reads —
 * `collectProjectTokenSources` (`handlers/studio/projectTokenSources.ts`) —
 * and lists it through `listProjectTokens`, the position-keeping view of the
 * same scan `studio_measure_reference` matches measurements against. So the
 * token this tool lists and the token a measurement is matched to cannot
 * disagree, and each one comes with the `file:line` that declares it.
 *
 * ## Bounded
 *
 * A design system can declare hundreds of tokens. Results are grouped by
 * family and paginated (`offset`/`limit`, `nextOffset` when more remain);
 * `counts` always covers the whole set so a filtered page never reads as the
 * whole palette.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../../runtime/types'
import {
  TOKEN_FAMILIES,
  listProjectTokens,
  type ListedToken,
  type TokenFamily,
} from '../../../../handlers/studio/projectTokenIndex'
import { collectProjectTokenSources } from '../../../../handlers/studio/projectTokenSources'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const DEFAULT_LIMIT = 200
/** Hard ceiling per call — well above a real palette's colour family, far below a payload that dominates a turn. */
const MAX_LIMIT = 400

const TokenFamilySchema = Type.Union(TOKEN_FAMILIES.map((family) => Type.Literal(family)), {
  description: 'Only this family: "color", "type" (font sizes, families, weights, line-heights, letter-spacing), "space", "radius", "shadow", or "other" (anything the scan could not place — z-index, durations, …).',
})

const TokensInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    filter: Type.Optional(
      Type.String({ description: 'Case-insensitive substring of the token name, e.g. "brand", "surface", "title".' }),
    ),
    family: Type.Optional(TokenFamilySchema),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Skip this many matching tokens — pass the previous result\'s nextOffset to continue. Default 0.' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `How many tokens to return. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.` }),
    ),
  },
  { additionalProperties: false },
)

/** One token as returned — its family is the group it sits in, its origin is its source file's, and its location is one `file:line` string. */
interface ReturnedToken {
  readonly name: string
  readonly value: string
  readonly dark?: string
  readonly aliasOf?: string
  readonly role?: ListedToken['role']
  readonly source: string
}

function toReturned(token: ListedToken): ReturnedToken {
  return {
    name: token.name,
    value: token.value,
    ...(token.dark === undefined ? {} : { dark: token.dark }),
    ...(token.aliasOf === undefined ? {} : { aliasOf: token.aliasOf }),
    ...(token.role === undefined ? {} : { role: token.role }),
    source: token.line === null ? token.file : `${token.file}:${token.line}`,
  }
}

const tokensTool: AiTool = {
  name: 'studio_list_tokens',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'List the design tokens this project actually has: every CSS custom property declared at the document root in the stylesheets the canvas loads — the global stylesheets the app entry imports (src/index.css), CSS Modules, compiled Sass/PostCSS/Tailwind output, package stylesheets, and Studio\'s built-in design system when the project uses it. Grouped by family (color, type, space, radius, shadow, other). Each token: name (what goes inside var()), value (resolved), dark (only when a dark-scheme value differs), aliasOf (when declared as var(--other)), role (type tokens: font-size, line-height, …) and source, the file:line of the declaration that wins. `sources` lists every stylesheet scanned with its origin; only origin "project" is yours to edit. Filter by name or family; page with offset/limit (nextOffset says where to continue). An empty list means the project declares no tokens.',
  inputSchema: TokensInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, filter, family, offset = 0, limit = DEFAULT_LIMIT } = input as {
      dir?: string
      filter?: string
      family?: TokenFamily
      offset?: number
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const sources = await collectProjectTokenSources(dir)
    const all = listProjectTokens(sources)

    const counts: Record<TokenFamily, number> = { color: 0, type: 0, space: 0, radius: 0, shadow: 0, other: 0 }
    const perSource = new Map<string, number>()
    for (const token of all) {
      counts[token.family] += 1
      perSource.set(token.file, (perSource.get(token.file) ?? 0) + 1)
    }

    const needle = filter?.trim().toLowerCase() ?? ''
    const matching = all.filter((token) =>
      (family === undefined || token.family === family) && (needle === '' || token.name.toLowerCase().includes(needle)))
    const page = matching.slice(offset, offset + limit)

    const families: Partial<Record<TokenFamily, ReturnedToken[]>> = {}
    for (const token of page) (families[token.family] ??= []).push(toReturned(token))

    return {
      ok: true,
      dir,
      total: matching.length,
      counts,
      families,
      sources: sources.map((source) => ({ file: source.file, origin: source.origin, tokens: perSource.get(source.file) ?? 0 })),
      ...(offset + page.length < matching.length ? { nextOffset: offset + page.length } : {}),
      ...(all.length === 0
        ? { note: 'No stylesheet the canvas loads declares a CSS custom property at the document root, so this project has no token layer. Use literal values and say so, or declare tokens in the global stylesheet the app entry imports.' }
        : {}),
    }
  },
}

export const studioProjectTokenMcpTools: AiTool[] = [tokensTool]
