/**
 * The DESCRIPTION, SEARCH KEYWORDS and GROUP for each vendored design-system
 * component — the half of the manifest that exists so a person can find a
 * component without already knowing its name.
 *
 * Every card in the Assets panel used to read `"<Name> — @alm-design/design-system"`,
 * which says nothing, and search was a substring match over the name, so
 * "header" found nothing and "pill" found nothing. Three inputs fix that, and
 * all three are read from the design system's own words wherever they exist:
 *
 *  - **description** — the first prose paragraph under `## <Name>` in
 *    `design.md`, cut to its first sentence. `design.md` opens every component
 *    with exactly that sentence ("Buttons trigger actions.", "Full-width 1px
 *    horizontal rule."), which is the one-liner a card wants. Falls back to the
 *    first paragraph under `### <Name>` in `CLAUDE.md`, then to a placeholder
 *    the coverage gate rejects — an undescribed component is a bug, not a
 *    state to render.
 *  - **keywords** — the union of the component's `design.md` Decision-Map
 *    intents ("I want to… show temporary feedback after an action" →
 *    `Snackbar`), its own documented enum values (`primary`, `destructive`,
 *    `payment`), its heading alias where the docs spell the name differently
 *    (`## List / ListItem`), and `studio/keywords.json` — Studio's curated
 *    synonym list, the only one of the four Studio authors, kept in the vendor
 *    folder BESIDE the upstream files so an upstream re-sync never has to
 *    merge it.
 *  - **group** — `studio/groups.json`. `design.md`'s table of contents is flat
 *    and ordered by document, not by purpose, so the grouping is Studio's
 *    editorial call. A component in no group throws here rather than landing
 *    in the panel under nothing.
 */
import { safeParseJson } from '@core/utils/jsonValidate'
import {
  DesignSystemGroupsFileSchema,
  DesignSystemKeywordsFileSchema,
  type DesignSystemGroupsFile,
  type DesignSystemKeywordsFile,
} from './designSystemSchemas'
import { readVendorFile } from './vendorRoot'
import type { VendorDocs } from './vendorDocs'

/** Marks a component whose docs yielded no description. The coverage gate fails on it. */
export function placeholderDescription(name: string): string {
  return `${name} component`
}

/** Strip the markdown a one-line card cannot render: emphasis, code ticks, links. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The first PROSE paragraph of a markdown section — skipping the heading, and
 * skipping any block that is a table, list, fence, blockquote or sub-heading.
 * Those forms all appear directly under a heading in these two documents and
 * none of them is a sentence about the component.
 */
function firstProseParagraph(section: string | null): string | null {
  if (!section) return null
  // `/\r?\n/`, never a bare `'\n'`: a CRLF document leaves a trailing `\r` on
  // every line and `.` does not match `\r` in a JS regex. See `vendorDocs.ts`'s
  // `headingsOf` for the full failure that caused.
  const lines = section.split(/\r?\n/).slice(1)
  const buffer: string[] = []
  let inFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (line === '') {
      if (buffer.length > 0) break
      continue
    }
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||!\[)/.test(line)) {
      if (buffer.length > 0) break
      continue
    }
    buffer.push(line)
  }
  if (buffer.length === 0) return null
  return stripMarkdown(buffer.join(' ')) || null
}

/**
 * The first sentence of a paragraph.
 *
 * Splits on a `.`/`!`/`?` followed by whitespace and a capital letter, which is
 * what every one of these paragraphs actually uses. A decimal, an abbreviation
 * ("1px.", "e.g. a"), and a lower-case continuation therefore do not split —
 * biased toward returning too much rather than a truncated fragment.
 */
function firstSentence(paragraph: string): string {
  const match = /^(.+?[.!?])\s+[A-Z(]/.exec(paragraph)
  return (match ? match[1]! : paragraph).trim()
}

/** The one-line description for a component, or the placeholder when nothing documents it. */
export function descriptionFor(docs: VendorDocs, name: string): string {
  const fromIntent = firstProseParagraph(docs.intentDoc(name))
  if (fromIntent) return firstSentence(fromIntent)
  const fromApi = firstProseParagraph(docs.apiDoc(name))
  if (fromApi) return firstSentence(fromApi)
  return placeholderDescription(name)
}

/**
 * Component names mentioned in a Decision-Map "Use" cell, by their backticks.
 *
 * A cell is usually a single `` `Component` ``, but two rows name a pattern
 * plus a component ("Select Pattern + `Radio`") and one names a folder of SVGs.
 * Taking every backticked token and keeping the ones that are real component
 * names handles all three without special cases.
 */
function componentsInUseCell(cell: string, known: ReadonlySet<string>): string[] {
  const names: string[] = []
  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const token = match[1]!.trim()
    if (known.has(token)) names.push(token)
  }
  return names
}

/** `Show a data-backed achievement ("Top rated…")` → `show a data-backed achievement`. */
function normalizeIntent(intent: string): string {
  return stripMarkdown(intent)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Decision-Map intents, keyed by the component each row resolves to.
 *
 * The table is the design system's own answer to "I know what I want, which
 * component is it" — the exact question a search box is asked — so every
 * intent becomes a keyword on the component it points at.
 */
export function intentKeywordsByComponent(
  docs: VendorDocs,
  componentNames: readonly string[],
): Map<string, string[]> {
  const known = new Set(componentNames)
  const byComponent = new Map<string, string[]>()
  // `/\r?\n/` for the same reason as `firstProseParagraph` above.
  for (const line of docs.decisionMap().split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    if (/^-+$/.test(cells[0]!.replace(/[: ]/g, '')) || cells[0] === 'I want to…') continue
    const intent = normalizeIntent(cells[0]!)
    if (!intent) continue
    for (const name of componentsInUseCell(cells[1]!, known)) {
      const list = byComponent.get(name) ?? []
      list.push(intent)
      byComponent.set(name, list)
    }
  }
  return byComponent
}

/**
 * Search aliases from the component's `design.md` heading, for the three whose
 * heading spells the name differently: `List / ListItem`, `System Banner`,
 * `Marketing Card`. Someone typing "system banner" should find `SystemBanner`.
 */
export function headingAliases(docs: VendorDocs, name: string): string[] {
  const title = docs.intentHeadingTitle(name)
  if (!title) return []
  const aliases: string[] = []
  for (const part of title.split('/')) {
    const alias = part.trim().toLowerCase()
    if (alias && alias !== name.toLowerCase()) aliases.push(alias)
  }
  return aliases
}

/** Read and validate `studio/keywords.json`. */
export function readCuratedKeywords(): DesignSystemKeywordsFile {
  const result = safeParseJson(readVendorFile('studio/keywords.json'), DesignSystemKeywordsFileSchema)
  if (!result.ok) {
    throw new Error(`vendor/alm-design-system/studio/keywords.json is malformed: ${result.error.message}`)
  }
  return result.value
}

/** Read and validate `studio/groups.json`. */
export function readCuratedGroups(): DesignSystemGroupsFile {
  const result = safeParseJson(readVendorFile('studio/groups.json'), DesignSystemGroupsFileSchema)
  if (!result.ok) {
    throw new Error(`vendor/alm-design-system/studio/groups.json is malformed: ${result.error.message}`)
  }
  return result.value
}

/**
 * Component name → group, from `studio/groups.json`.
 *
 * Throws when a component is listed twice: a component belongs to exactly one
 * Assets-panel section, and two homes means the panel's own ordering decides,
 * silently.
 */
export function groupByComponent(groups: DesignSystemGroupsFile): Map<string, string> {
  const byComponent = new Map<string, string>()
  for (const [group, names] of Object.entries(groups)) {
    for (const name of names) {
      const existing = byComponent.get(name)
      if (existing) {
        throw new Error(
          `vendor/alm-design-system/studio/groups.json lists ${name} in both "${existing}" and "${group}"`,
        )
      }
      byComponent.set(name, group)
    }
  }
  return byComponent
}

/**
 * Enum values worth searching for.
 *
 * A component's variant names ARE how people look for it — "destructive",
 * "payment", "sponsored" — with two exceptions that identify nothing. `dir`
 * is documented as an enum on all 39 components, so `ltr` / `rtl` would match
 * everything, and the JSON-ish literals a doc comment sometimes lists
 * (`null`, `false`) are not names at all.
 */
export function enumKeywords(props: readonly { name: string; enumValues?: string[] }[]): string[] {
  const NON_NAMES = new Set(['null', 'undefined', 'true', 'false'])
  const out: string[] = []
  for (const prop of props) {
    if (prop.name === 'dir') continue
    for (const value of prop.enumValues ?? []) {
      if (!NON_NAMES.has(value.toLowerCase())) out.push(value)
    }
  }
  return out
}

/** The final keyword list: every source, lower-cased, de-duplicated, sorted. */
export function keywordsFor(inputs: {
  intents: readonly string[]
  enumValues: readonly string[]
  aliases: readonly string[]
  curated: readonly string[]
}): string[] {
  const all = new Set<string>()
  for (const source of [inputs.intents, inputs.enumValues, inputs.aliases, inputs.curated]) {
    for (const keyword of source) {
      const normalized = keyword.trim().toLowerCase()
      if (normalized) all.add(normalized)
    }
  }
  return [...all].sort()
}
