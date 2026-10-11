/**
 * `studio_find_icon` — a fuzzy search over the design system's icon catalogs,
 * returning for each match the exact way to use it in THIS project (P4-E,
 * AI-13).
 *
 * ## Why this exists
 *
 * The Assets ladder's first rung is "the design system's own icon set". The
 * agent reached it by reading a generated markdown list of several hundred
 * file names and guessing: is the magnifier called `search`, `magnifier`,
 * `loupe` or `find`? A wrong guess is an import of a file that does not exist
 * (`unresolved-asset-import`), an icon that comes out as an empty box, and a
 * hand-drawn `<path>` as the "fix". This does the lookup: word-level matching
 * with prefixes, a small synonym table for the names designers disagree on,
 * and typo tolerance, over the SAME catalog the canvas's icon picker offers
 * (`iconCatalog.ts`'s `collectStudioIcons`).
 *
 * ## What "use it" means, per source
 *
 *   - **An installed package's SVG** — `import x from '<pkg>/<path>.svg?raw'`,
 *     inlined. The only form that renders on the canvas and inherits
 *     `currentColor` (see `designSystemGuide.ts`'s `renderIconReference`).
 *   - **Studio's built-in design system** — the same `?raw` import, relative
 *     to the file, into the project's `design-system/icons/…`. The folder
 *     carries only the icons something imports, but that set is demand-driven:
 *     `ensureDesignSystemFiles` runs on every load and copies in each icon a
 *     project file imports (`collectProjectIconDemand`), so writing the import
 *     IS how the file arrives. That holds only for a project whose
 *     `.studio/meta.json` says `designSystem: 'alm'`.
 *   - **Built-in, in a project Studio does not maintain the folder for** —
 *     nothing would copy the file in, so the match carries the SVG markup and
 *     a path to save it at; the agent writes the file with its file tool and
 *     imports it. Markup is capped per call so a broad query cannot flood the
 *     context.
 *
 * A read: it never writes. With no catalog at all it says so, and what to ask
 * the user for.
 */
import { posix } from 'node:path'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { PROJECT_DESIGN_SYSTEM_DIR } from '@core/page-parser'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pathRefusal } from './fileReadTools'
import { AGENT_PATH_MAX_CHARS, resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { BUILTIN_ICON_SOURCE_NAME, collectStudioIcons, type StudioIcon } from '../../../../handlers/studio/iconCatalog'
import { readStudioMeta } from '../../../../handlers/studio/studioMeta'

const DEFAULT_LIMIT = 6
const MAX_LIMIT = 12
/** Total inline SVG markup one call may return. A line icon is 0.5–2 KB, so this is every match of a normal query. */
const MARKUP_BUDGET_BYTES = 24 * 1024
/** Where a built-in icon that is not in the project yet should be saved. */
const LANDED_ICON_DIR = 'src/assets/icons'

/**
 * Names designers disagree on. Each row is one idea; a query word matching any
 * word in a row also looks for the others. Small on purpose: this is for the
 * common UI glyphs, not a thesaurus.
 */
const SYNONYM_ROWS: readonly (readonly string[])[] = [
  ['search', 'magnifier', 'magnifying', 'loupe', 'find', 'zoom'],
  ['close', 'x', 'cross', 'dismiss', 'cancel'],
  ['delete', 'trash', 'bin', 'remove', 'garbage'],
  ['settings', 'gear', 'cog', 'preferences', 'options'],
  ['home', 'house'],
  ['user', 'person', 'profile', 'account', 'avatar', 'people'],
  ['cart', 'basket', 'bag', 'shopping', 'trolley'],
  ['mail', 'email', 'envelope', 'letter', 'message', 'inbox'],
  ['phone', 'call', 'telephone', 'mobile'],
  ['calendar', 'date', 'schedule', 'event'],
  ['notification', 'bell', 'alert', 'alarm'],
  ['menu', 'hamburger', 'burger', 'more', 'dots', 'ellipsis'],
  ['back', 'previous', 'left', 'return'],
  ['forward', 'next', 'right'],
  ['edit', 'pencil', 'pen', 'write', 'modify'],
  ['location', 'pin', 'marker', 'map', 'place', 'gps'],
  ['heart', 'like', 'love', 'favorite', 'favourite'],
  ['star', 'rating', 'favorite', 'favourite', 'bookmark'],
  ['info', 'information', 'about', 'help'],
  ['warning', 'caution', 'attention', 'exclamation', 'error'],
  ['check', 'tick', 'done', 'success', 'ok', 'confirm'],
  ['plus', 'add', 'new', 'create'],
  ['minus', 'subtract', 'less'],
  ['download', 'save', 'export'],
  ['upload', 'import'],
  ['share', 'send', 'forward'],
  ['lock', 'padlock', 'secure', 'password', 'private'],
  ['eye', 'view', 'visible', 'show', 'preview'],
  ['wifi', 'wireless', 'signal', 'network'],
  ['globe', 'world', 'language', 'internet', 'web', 'earth'],
  ['card', 'credit', 'payment', 'pay', 'wallet'],
  ['chat', 'comment', 'bubble', 'conversation', 'speech'],
  ['camera', 'photo', 'picture', 'image'],
  ['clock', 'time', 'history', 'recent'],
  ['filter', 'funnel', 'sort'],
  ['logout', 'exit', 'signout', 'leave'],
  ['refresh', 'reload', 'sync', 'update'],
  ['chevron', 'arrow', 'caret'],
]

const SYNONYMS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, Set<string>>()
  for (const row of SYNONYM_ROWS) {
    for (const word of row) {
      const set = map.get(word) ?? new Set<string>()
      for (const other of row) if (other !== word) set.add(other)
      map.set(word, set)
    }
  }
  return new Map([...map].map(([word, set]) => [word, [...set]]))
})()

/** Lower-case words, split on separators AND camelCase boundaries: `arrowLeft-1` is `arrow`, `left`, `1`. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
}

/** Levenshtein distance, bounded: returns `max + 1` as soon as the answer exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]!
}

/** How well one query word matches one name word: 0 (not at all) to 10 (exactly). */
function wordScore(query: string, candidate: string): number {
  if (query === candidate) return 10
  if (query.length >= 3 && candidate.startsWith(query)) return 7
  if (candidate.length >= 3 && query.startsWith(candidate)) return 6
  if (query.length >= 4 && candidate.includes(query)) return 5
  if (query.length >= 5 && editDistance(query, candidate, 1) <= 1) return 4
  if (query.length >= 7 && editDistance(query, candidate, 2) <= 2) return 3
  return 0
}

export interface IconMatchScore {
  readonly matched: number
  readonly score: number
}

/** Every query word scores its best match among the icon's name words (group words count less; a synonym counts 80 %). */
export function scoreIcon(queryWords: readonly string[], icon: Pick<StudioIcon, 'name' | 'group'>): IconMatchScore {
  const nameWords = words(icon.name)
  const groupWords = words(icon.group)
  const joinedName = nameWords.join('')
  let matched = 0
  let score = queryWords.join('') === joinedName ? 20 : 0
  for (const query of queryWords) {
    let best = 0
    for (const candidate of nameWords) best = Math.max(best, wordScore(query, candidate))
    if (best < 10) {
      for (const synonym of SYNONYMS.get(query) ?? []) {
        for (const candidate of nameWords) best = Math.max(best, wordScore(synonym, candidate) * 0.8)
      }
    }
    if (best === 0) for (const candidate of groupWords) best = Math.max(best, wordScore(query, candidate) * 0.3)
    if (best > 0) matched += 1
    score += best
  }
  return { matched, score }
}

/** `arrow-left` → `arrowLeftSvg`: an identifier the import can bind. */
function bindingName(name: string): string {
  const parts = words(name)
  const camel = parts.map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1))).join('')
  const safe = /^[a-z]/.test(camel) ? camel : `icon${camel[0]?.toUpperCase() ?? ''}${camel.slice(1)}`
  return `${safe}Svg`
}

/** A `?raw` specifier from `fromFile` to a project file, `./`-prefixed. */
function relativeSpecifier(fromFileRel: string, targetRel: string): string {
  const rel = posix.relative(posix.dirname(fromFileRel), targetRel)
  return rel.startsWith('.') ? rel : `./${rel}`
}

const FindIconInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: 'Absolute project directory. Omit it: it defaults to the project open in Studio.' })),
    query: Type.String({
      minLength: 1,
      maxLength: 80,
      description: 'What the icon shows, in one to three words: "search", "arrow left", "credit card", "bell". Common synonyms and small typos are matched.',
    }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `How many matches, best first. Default ${DEFAULT_LIMIT}.` })),
    forFile: Type.Optional(Type.String({
      minLength: 1,
      maxLength: AGENT_PATH_MAX_CHARS,
      description: 'The project-relative file the icon goes into, e.g. "pages/Checkout.tsx", so each import comes back relative to it. It need not exist yet.',
    })),
  },
  { additionalProperties: false },
)

interface IconMatch {
  readonly name: string
  readonly group: string
  readonly source: string
  readonly score: number
  /** The import line to write, when there is a file to import. */
  readonly import?: string
  /** For an icon not in the project yet: where to save `markup` before importing it. */
  readonly saveAs?: string
  readonly markup?: string
  readonly usage: string
}

export function findIcons(
  dir: string,
  input: { query: string; limit?: number; forFile?: string },
  icons: readonly StudioIcon[],
): { matches: IconMatch[]; truncatedMarkup: boolean } {
  const queryWords = words(input.query)
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const ranked = icons
    .map((icon) => ({ icon, ...scoreIcon(queryWords, icon) }))
    .filter((entry) => entry.score > 0)
    // Every query word matched beats a higher total from some of them.
    .sort((a, b) => b.matched - a.matched || b.score - a.score || a.icon.name.length - b.icon.name.length || a.icon.id.localeCompare(b.icon.id))
    .slice(0, limit)

  const from = input.forFile ?? 'pages/Screen.tsx'
  // Studio copies an imported built-in icon into `design-system/` on the next
  // load for exactly these projects (see the module doc).
  const studioMaintainsFolder = readStudioMeta(dir).designSystem === 'alm'
  let markupBudget = MARKUP_BUDGET_BYTES
  let truncatedMarkup = false
  const matches = ranked.map(({ icon, score }): IconMatch => {
    const binding = bindingName(icon.name)
    const usage = `<span className={styles.icon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: ${binding} }} />`
    const base = { name: icon.name, group: icon.group, source: icon.pkg, score: Math.round(score * 10) / 10, usage }
    if (icon.pkg !== BUILTIN_ICON_SOURCE_NAME) {
      return { ...base, import: `import ${binding} from '${icon.pkg}/${icon.packagePath}?raw'` }
    }
    // Studio's built-in system: vendored `src/icons/…` is the project's `design-system/icons/…`.
    const projectPath = `${PROJECT_DESIGN_SYSTEM_DIR}/${icon.packagePath.replace(/^src\//, '')}`
    if (studioMaintainsFolder || existsSync(join(dir, ...projectPath.split('/')))) {
      return { ...base, import: `import ${binding} from '${relativeSpecifier(from, projectPath)}?raw'` }
    }
    const saveAs = `${LANDED_ICON_DIR}/${words(icon.name).join('-') || 'icon'}.svg`
    const bytes = Buffer.byteLength(icon.markup, 'utf8')
    if (bytes > markupBudget) {
      truncatedMarkup = true
      return { ...base, saveAs }
    }
    markupBudget -= bytes
    return { ...base, saveAs, markup: icon.markup, import: `import ${binding} from '${relativeSpecifier(from, saveAs)}?raw'` }
  })
  return { matches, truncatedMarkup }
}

const findIconTool: AiTool = {
  name: 'studio_find_icon',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  requiredCapabilities: [],
  description:
    'Find an icon in the project\'s design-system icon set by what it shows ("search", "arrow left", "bell"), with synonyms and typos matched — before you ever hand-draw a path. Returns matches best first, each with the exact ?raw import line for forFile (pass it: imports are relative) and a usage that inlines the SVG (so it inherits currentColor). Write the import as given; Studio brings a built-in icon file into design-system/ itself. A match with saveAs and markup is the exception: write markup to saveAs with your file tool, then use its import. No catalog → says so, with what to ask the user for. A read; writes nothing.',
  inputSchema: FindIconInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, query, limit, forFile } = input as { dir?: string; query: string; limit?: number; forFile?: string }
    const dir = resolveToolProjectDir(dirInput, ctx)
    let fromFile: string | undefined
    if (forFile !== undefined) {
      const target = resolveAgentFilePath(dir, forFile, 'read')
      if (!target.ok) return pathRefusal(target)
      fromFile = target.rel
    }
    const icons = collectStudioIcons(dir)
    if (icons.length === 0) {
      return {
        ok: true,
        catalogSize: 0,
        matches: [],
        message: 'This project has no design-system icon files Studio can read, so there is nothing to search. Ask the user whether to add an icon package (studio_install_deps installs one once the project\'s trust tier allows it) or to supply the SVGs. Until then, leave a neutral box and name the icon it needs — never draw one.',
      }
    }
    const { matches, truncatedMarkup } = findIcons(dir, { query, limit, forFile: fromFile }, icons)
    return {
      ok: true,
      catalogSize: icons.length,
      query,
      matches,
      ...(matches.length === 0
        ? { message: `No icon in the ${icons.length}-icon catalog matched "${query}". Try the thing it depicts in one word ("magnifier" → "search", "bin" → "trash"), or a broader shape ("arrow", "circle").` }
        : {}),
      ...(truncatedMarkup ? { note: 'Some matches omit markup to keep this result small; call again with a narrower query or a lower limit to get theirs.' } : {}),
    }
  },
}

export const studioFindIconMcpTools: AiTool[] = [findIconTool]
