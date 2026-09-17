/**
 * colorTokens — the built-in design system's palette, as data the Assets
 * panel can put on screen (DS-7).
 *
 * The source is `alm-design-system/dist/tokens.generated.json`, written by
 * `bun run alm:sync` from the design system's own `src/tokens/*.css` and kept
 * honest by `alm-design-system-fresh.test.ts`. Reading it here means Colors
 * works with nothing installed in the user's project and no CSS parsed in the
 * browser — the palette is a fact about the design system, not about what the
 * open project happens to have on disk.
 *
 * Three things worth knowing:
 *
 *  - **It is validated once, at module load.** The JSON is generated, but it
 *    still crosses into the app as an untyped value, so it goes through
 *    `DesignSystemColorTokensSchema` like any other boundary. A malformed file
 *    yields an empty palette and one `console.error`, not a panel that throws.
 *  - **Colour tokens are NOT `AssetItem`s.** Every kind in `assetsModel.ts` is
 *    something `useInsertInserterItem` can insert as a node; a colour is not.
 *    It gets its own item type that satisfies `RankableAsset`, so it rides the
 *    same `rankAssets` search without pretending to be insertable.
 *  - **The schema comes from a deep import.** `@core/design-system-manifest`'s
 *    barrel also exports `buildDesignSystemManifest`/`extractColorTokens`,
 *    which import `node:fs` — pulling the barrel into browser code would drag
 *    those in. The schema module itself is a pure TypeBox leaf.
 */
import tokensJson from 'alm-design-system/dist/tokens.generated.json'
import {
  DesignSystemColorTokensSchema,
  type DesignSystemColorToken,
} from '@core/design-system-manifest/designSystemSchemas'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import type { RankableAsset } from './rankAssets'

/**
 * Palette families first, in the order the design system's own stylesheet
 * declares them (neutrals, then each hue, then brand), then the values that
 * are not a hue at all (alpha overlays, gradient stops), then the semantic
 * families in the order a designer reaches for them: what a surface is, what
 * sits on it, what bounds it, what marks it.
 *
 * A group this list has not heard of sorts after these, alphabetically — a
 * new family upstream appears at the end rather than disappearing.
 */
export const COLOR_GROUP_ORDER: readonly string[] = [
  'Neutral',
  'Aqua',
  'Coral',
  'Forest',
  'Butter',
  'Purple',
  'Brand',
  'Alpha',
  'Gradients',
  'Semantic background',
  'Semantic text',
  'Semantic border',
  'Semantic icon',
]

/** One swatch: a design-system colour token, rankable by the panel's search. */
export interface ColorAssetItem extends RankableAsset {
  kind: 'color'
  /** React key and copy target — the custom property name, e.g. `--color-aqua-100`. */
  key: string
  token: DesignSystemColorToken
}

/**
 * The validated palette. Empty (plus one logged error) when the generated file
 * does not match its schema, which the section renders as an empty state.
 */
export const DESIGN_SYSTEM_COLOR_TOKENS: readonly DesignSystemColorToken[] = readColorTokens()

function readColorTokens(): readonly DesignSystemColorToken[] {
  const result = safeParseValue(DesignSystemColorTokensSchema, tokensJson)
  if (!result.ok) {
    console.error(
      '[colorTokens] tokens.generated.json does not match DesignSystemColorTokensSchema:',
      result.errors,
    )
    return []
  }
  return result.value
}

/** What a click copies, and what an apply writes: `var(--color-aqua-100)`. */
export function colorVarReference(tokenName: string): string {
  return `var(${tokenName})`
}

/**
 * The tooltip line: what the click does, and both values, because a swatch
 * showing two halves is useless without the numbers behind them.
 */
export function colorTokenTooltip(token: DesignSystemColorToken): string {
  return token.light === token.dark
    ? `Copy ${colorVarReference(token.name)} · ${token.light} in both themes`
    : `Copy ${colorVarReference(token.name)} · Light ${token.light} · Dark ${token.dark}`
}

/**
 * Search terms for one token. A designer looks for a colour by family
 * ("coral"), by name ("aqua-100"), or by the value they copied out of a mock
 * ("#E9666F") — all three are keywords, so all three hit.
 */
function keywordsForToken(token: DesignSystemColorToken): string[] {
  const stripped = token.name.replace(/^--/, '')
  const terms = [token.group, token.light, token.dark, stripped, ...stripped.split('-')]
  const seen = new Set<string>()
  const keywords: string[] = []
  for (const term of terms) {
    const trimmed = term.trim()
    if (trimmed === '') continue
    const dedupeKey = trimmed.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    keywords.push(trimmed)
  }
  return keywords
}

/** Every colour token as a searchable item, in the JSON's own order. */
export function buildColorAssetItems(
  tokens: readonly DesignSystemColorToken[] = DESIGN_SYSTEM_COLOR_TOKENS,
): ColorAssetItem[] {
  return tokens.map((token) => ({
    kind: 'color',
    key: token.name,
    name: token.name,
    description:
      token.light === token.dark
        ? `${token.group} · ${token.light}`
        : `${token.group} · light ${token.light} · dark ${token.dark}`,
    keywords: keywordsForToken(token),
    token,
  }))
}

/**
 * Splits items into their groups, `COLOR_GROUP_ORDER` first and then
 * alphabetically — the same deterministic rule `AssetsPanel`'s
 * `groupByCategory` uses for components, so the panel never has two orders.
 */
export function groupColorItems<TItem extends { token: DesignSystemColorToken }>(
  items: readonly TItem[],
): [string, TItem[]][] {
  const groups = new Map<string, TItem[]>()
  for (const item of items) {
    const bucket = groups.get(item.token.group) ?? []
    bucket.push(item)
    groups.set(item.token.group, bucket)
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const orderA = COLOR_GROUP_ORDER.indexOf(a)
    const orderB = COLOR_GROUP_ORDER.indexOf(b)
    if (orderA !== -1 && orderB !== -1) return orderA - orderB
    if (orderA !== -1) return -1
    if (orderB !== -1) return 1
    return a.localeCompare(b)
  })
}
