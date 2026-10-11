/**
 * tokenCatalog — the project's design tokens as a catalog with MODES and
 * USAGE (CT-1). One server module behind `GET /admin/api/studio/token-catalog`,
 * which is what the inspector's "Apply variable" picker and the Variables
 * panel read.
 *
 * ## What it replaced
 *
 * The picker used to scan the two concatenated stylesheet strings the canvas
 * already carried (`projectVariables.ts`'s own regex), which cannot say which
 * FILE a variable lives in, which of its declarations is the dark one, or
 * whether a package or the project owns it - so it could not tell the user
 * "this is read-only" or write an edit to the right place. Reading the sources
 * `collectProjectTokenSources` already assembles (the exact stylesheet stack
 * the canvas loads, in cascade order, with provenance) answers all three, and
 * is the SAME scan `studio_set_tokens` writes through.
 *
 * ## A token, a collection, a mode
 *
 *   - **Token** - a CSS custom property, with every declaration of it
 *     (`decls`), each gated (`:root`, `[data-theme="dark"]`, `@media ...`).
 *   - **Collection** - the declaring stylesheet x the leading name segment
 *     (`--color-*`, `--space-*`). No sidecar file; nothing is stored.
 *   - **Mode** - inferred from the gates found (`@core/studio-tokens`
 *     `modeOfGate`). The default mode of every axis is the `base` gate.
 *
 * Studio's Framework scales are deliberately NOT here: they are a generator,
 * not the user's token layer (CT-OD-1). The editor lists them as a separate,
 * read-only collection.
 */
import {
  gateKey,
  findTokenMentions,
  lineOfOffset,
  modeOfGate,
  resolveVarValue,
  scanGatedDeclarations,
  type CatalogToken,
  type ModeAxis,
  type ModeGate,
  type TokenCatalog,
  type TokenCollection,
  type TokenDecl,
  type TokenFamily,
  type TokenUsage,
} from '@core/studio-tokens'
import { readTokenWorkspaceFiles } from './tokenWorkspaceFiles'
import { classifyDesignTokenFamily } from './tokenExtractCssScan'
import { familyOf, type TokenCssSource } from './projectTokenIndex'

/** A vendor bundle can declare thousands; the picker and the panel are not for that. */
const MAX_TOKENS = 4000
const VAR_ALIAS_RE = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/

/** One declaration located in its source, before the per-name grouping. */
interface Located {
  readonly name: string
  readonly gate: ModeGate
  readonly selector: string | null
  readonly atRules: readonly string[]
  readonly raw: string
  readonly source: TokenCssSource
  readonly line: number | null
  readonly inTheme: boolean
}

export function collectionIdFor(file: string, name: string): string {
  const prefix = name.slice(2).split('-')[0] ?? ''
  return `${file}#${prefix}`
}

function collectionLabel(id: string): string {
  const prefix = id.slice(id.lastIndexOf('#') + 1)
  return prefix.length > 0 ? prefix : 'general'
}

/**
 * Build the catalog from the stylesheets the canvas loads, in cascade order
 * (a later source overrides an earlier one). Pure over its input - the caller
 * does the I/O (`collectProjectTokenSources`) and, when it wants usage, the
 * scan ({@link scanTokenUsage}).
 */
export function buildTokenCatalog(sources: readonly TokenCssSource[], usage?: ReadonlyMap<string, TokenUsage>): TokenCatalog {
  const located: Located[] = []
  for (const source of sources) {
    if (!source.css) continue
    for (const declaration of scanGatedDeclarations(source.css)) {
      located.push({
        name: declaration.name,
        gate: declaration.gate,
        selector: declaration.selector,
        atRules: declaration.atRules,
        raw: declaration.raw,
        source,
        line: source.origin === 'compiled' ? null : lineOfOffset(source.css, declaration.offset),
        inTheme: declaration.inTheme,
      })
    }
  }

  // Cascade: the last declaration of a name under a gate is the one that paints.
  const valuesByGate = new Map<string, Map<string, string>>()
  const winnerIndex = new Map<string, number>()
  located.forEach((entry, index) => {
    const key = gateKey(entry.gate)
    let values = valuesByGate.get(key)
    if (!values) valuesByGate.set(key, (values = new Map()))
    values.set(entry.name, entry.raw)
    winnerIndex.set(`${key}|${entry.name}`, index)
  })
  const baseValues = valuesByGate.get('base') ?? new Map<string, string>()
  const resolutionMaps = new Map<string, ReadonlyMap<string, string>>()
  const mapFor = (key: string): ReadonlyMap<string, string> => {
    if (key === 'base') return baseValues
    let merged = resolutionMaps.get(key)
    if (!merged) {
      merged = new Map([...baseValues, ...(valuesByGate.get(key) ?? [])])
      resolutionMaps.set(key, merged)
    }
    return merged
  }

  const byName = new Map<string, { decls: TokenDecl[]; family: TokenFamily; baseFile: string | null; firstFile: string }>()
  located.forEach((entry, index) => {
    let token = byName.get(entry.name)
    if (!token) {
      if (byName.size >= MAX_TOKENS) return
      const baseRaw = baseValues.get(entry.name)
      const resolvedForFamily = resolveVarValue(baseRaw ?? entry.raw, baseValues)
      token = { decls: [], family: familyOf(classifyDesignTokenFamily(entry.name, resolvedForFamily)).family, baseFile: null, firstFile: entry.source.file }
      byName.set(entry.name, token)
    }
    const key = gateKey(entry.gate)
    const alias = VAR_ALIAS_RE.exec(entry.raw)?.[1]
    token.decls.push({
      gate: entry.gate,
      selector: entry.selector,
      atRules: [...entry.atRules],
      value: entry.raw,
      resolvedValue: resolveVarValue(entry.raw, mapFor(key)),
      ...(alias ? { aliasOf: alias } : {}),
      file: entry.source.file,
      line: entry.line,
      origin: entry.source.origin,
      winning: winnerIndex.get(`${key}|${entry.name}`) === index,
      inTheme: entry.inTheme,
    })
    if (key === 'base') token.baseFile = entry.source.file
  })

  const collections = new Map<string, TokenCollection>()
  const tokens: CatalogToken[] = []
  for (const [name, token] of byName) {
    const file = token.baseFile ?? token.firstFile
    const collection = collectionIdFor(file, name)
    if (!collections.has(collection)) {
      const origin = token.decls.find((decl) => decl.file === file)?.origin ?? 'project'
      collections.set(collection, { id: collection, label: collectionLabel(collection), file, origin, editable: origin === 'project' })
    }
    tokens.push({
      name,
      family: token.family,
      collection,
      decls: token.decls,
      ...(usage ? { usage: usage.get(name) ?? { count: 0, sites: [] } } : {}),
    })
  }

  return { tokens, collections: [...collections.values()], axes: inferModeAxes(tokens) }
}

/** The extra modes found among the declared gates, grouped into axes (the default mode of each is the base gate). */
export function inferModeAxes(tokens: readonly CatalogToken[]): ModeAxis[] {
  const axes = new Map<string, ModeAxis>()
  for (const token of tokens) {
    for (const decl of token.decls) {
      const mode = modeOfGate(decl.gate)
      if (!mode) continue
      let axis = axes.get(mode.axisId)
      if (!axis) axes.set(mode.axisId, (axis = { id: mode.axisId, label: mode.axisLabel, modes: [] }))
      if (!axis.modes.some((existing) => existing.id === mode.modeId)) {
        axis.modes.push({ id: mode.modeId, label: mode.modeLabel, gate: decl.gate })
      }
    }
  }
  return [...axes.values()]
}

// ---------------------------------------------------------------------------
// Usage - where each token is read (P6)
// ---------------------------------------------------------------------------

const MAX_SITES_PER_TOKEN = 25

/**
 * Every place the project reads a custom property: any mention of its name
 * that is not a declaration (`@core/studio-tokens` `findTokenMentions` - the
 * ONE definition rename and remove use too, so a count of 0 means removing it
 * breaks nothing). One server-side pass over the workspace file list (not in a
 * selector path), cheap enough to run per request; the catalog asks for it
 * only when a panel shows counts.
 */
export function scanTokenUsage(dir: string): Map<string, TokenUsage> {
  const found = new Map<string, { count: number; sites: Array<{ file: string; line: number }> }>()
  for (const { file, text } of readTokenWorkspaceFiles(dir)) {
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      for (const mention of findTokenMentions(lines[index]!)) {
        if (mention.declaration) continue
        let entry = found.get(mention.name)
        if (!entry) found.set(mention.name, (entry = { count: 0, sites: [] }))
        entry.count++
        if (entry.sites.length < MAX_SITES_PER_TOKEN) entry.sites.push({ file, line: index + 1 })
      }
    }
  }
  return found
}
