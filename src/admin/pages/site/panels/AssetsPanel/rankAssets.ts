/**
 * rankAssets — the Assets panel's search.
 *
 * The insert dialog matched one `[name, id, category, description].join(' ')`
 * substring, which made every hit equal: typing "button" put `ButtonGroup`,
 * `IconButton` and a description mentioning "button" ahead of `Button` roughly
 * at random, and typing a PURPOSE ("header", "pill", "row") found nothing at
 * all because the words a designer uses are not the words a component library
 * names itself with.
 *
 * So: a score, over four fields, with keywords as a first-class field.
 *
 *   name prefix              3    "but" → Button
 *   keyword exact            2    "pill" → Chip
 *   name / keyword substring 1.5  "nav" → Navbar, "app bar" → Navbar
 *   description substring    1    the long tail
 *
 * A multi-word query is tokenised and every token must hit something (AND),
 * because "bottom sheet" should not match every component that mentions
 * "bottom". Scores add up across tokens, so a two-token exact match outranks a
 * one-token one.
 *
 * Sections keep their declared order — this only sorts WITHIN a section, so
 * "Design system" never jumps below "Layouts" because one card scored higher.
 * The winning keyword comes back with the item so a card can show WHY it
 * matched when the reason is not its own name.
 */

export interface RankableAsset {
  name: string
  description: string
  keywords: string[]
}

export interface RankedAsset<TItem extends RankableAsset> {
  item: TItem
  score: number
  /**
   * The keyword that earned the hit, when the match did NOT come from the
   * item's own name. `null` when the name matched (showing "button" under a
   * card called Button is noise) or when nothing matched at all.
   */
  matchedKeyword: string | null
}

const SCORE_NAME_PREFIX = 3
const SCORE_KEYWORD_EXACT = 2
const SCORE_SUBSTRING = 1.5
const SCORE_DESCRIPTION = 1

/** Query tokens: lowercased, whitespace-split, empties dropped. */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Score one item against one token. Returns `0` when the token misses
 * entirely, which is what makes the AND rule above work.
 */
function scoreToken(
  item: RankableAsset,
  token: string,
): { score: number; keyword: string | null; nameHit: boolean } {
  const name = item.name.toLowerCase()
  if (name.startsWith(token)) return { score: SCORE_NAME_PREFIX, keyword: null, nameHit: true }

  for (const keyword of item.keywords) {
    if (keyword.toLowerCase() === token) {
      return { score: SCORE_KEYWORD_EXACT, keyword, nameHit: false }
    }
  }

  if (name.includes(token)) return { score: SCORE_SUBSTRING, keyword: null, nameHit: true }

  for (const keyword of item.keywords) {
    if (keyword.toLowerCase().includes(token)) {
      return { score: SCORE_SUBSTRING, keyword, nameHit: false }
    }
  }

  if (item.description.toLowerCase().includes(token)) {
    return { score: SCORE_DESCRIPTION, keyword: null, nameHit: false }
  }

  return { score: 0, keyword: null, nameHit: false }
}

/**
 * Ranks `items` against `query`, highest first, dropping everything that does
 * not match every token. An empty query returns every item in its original
 * order with score 0 — the section's own order IS the answer when nobody is
 * searching.
 */
export function rankAssets<TItem extends RankableAsset>(
  query: string,
  items: readonly TItem[],
): RankedAsset<TItem>[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) {
    return items.map((item) => ({ item, score: 0, matchedKeyword: null }))
  }

  const ranked: RankedAsset<TItem>[] = []
  for (const item of items) {
    let total = 0
    let matchedKeyword: string | null = null
    let everyTokenHit = true
    let anyNameHit = false

    for (const token of tokens) {
      const hit = scoreToken(item, token)
      if (hit.score === 0) {
        everyTokenHit = false
        break
      }
      total += hit.score
      if (hit.nameHit) anyNameHit = true
      // First keyword wins — the chip explains the match, it is not an audit.
      if (hit.keyword && !matchedKeyword) matchedKeyword = hit.keyword
    }

    if (!everyTokenHit) continue
    ranked.push({ item, score: total, matchedKeyword: anyNameHit ? null : matchedKeyword })
  }

  // Stable within equal scores: `sort` on a copy built in source order, and the
  // comparator only ever reorders on a real difference.
  return ranked.sort((a, b) => b.score - a.score)
}
