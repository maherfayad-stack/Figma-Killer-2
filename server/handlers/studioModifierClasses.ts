/**
 * studioModifierClasses — a class that only exists as the second half of a
 * compound rule is still a class the page can carry.
 *
 * `className="card card-home-2"` with `.card.card-home-2 { padding: 20px }` in
 * the stylesheet: the registry has a rule for `.card` and, for the compound, an
 * AMBIENT rule — no class rule named `card-home-2`. `classIdsForClassName` keeps
 * only names that have one, so the canvas element would lose `card-home-2` and
 * the compound would never match it (and the panel would show `.card`'s 8px
 * where the element renders 20px). That is the shape a per-instance class
 * override writes (`@core/css-codemods`' `modifierRule.ts`), and also what any
 * hand-written `.btn.primary` looks like.
 *
 * So a compound `.A.B` whose `B` has no rule of its own, and which no other
 * compound rule also ends in, registers `B` as a class rule carrying the
 * compound's declarations, mapped to the compound's own `(file, selector)` so an
 * edit to `B` rewrites that rule and nothing else. The ambient compound rule it
 * came from is replaced by it. A `B` two rules claim (`.btn.active`,
 * `.tab.active`) is left alone: there is no one honest rule for the name.
 */
import { parseModifierSelector } from '@core/css-codemods'
import type { StyleRule } from '@core/page-tree'
import { createHash } from 'node:crypto'
import { IMPORTED_RULE_ID_PREFIX } from '@core/page-tree'

function ruleId(name: string, file: string): string {
  return `${IMPORTED_RULE_ID_PREFIX}${createHash('sha1').update(`class|${name}|${file}`).digest('hex').slice(0, 10)}`
}

export function registerModifierClasses(
  styleRules: Record<string, StyleRule>,
  classIdsByName: Record<string, string>,
  sources: Record<string, { file: string; selector: string }>,
): void {
  const byToken = new Map<string, { id: string; rule: StyleRule }[]>()
  for (const [id, rule] of Object.entries(styleRules)) {
    if (rule.kind !== 'ambient') continue
    const parsed = parseModifierSelector(rule.selector)
    if (!parsed || parsed.base === `.${parsed.token}`) continue
    const list = byToken.get(parsed.token) ?? []
    list.push({ id, rule })
    byToken.set(parsed.token, list)
  }
  for (const [token, claims] of byToken) {
    if (claims.length !== 1 || classIdsByName[token] !== undefined) continue
    const { id: ambientId, rule } = claims[0]!
    const source = sources[ambientId]
    const id = ruleId(token, source?.file ?? '')
    styleRules[id] = { ...rule, id, kind: 'class', name: token, selector: `.${token}` }
    delete styleRules[ambientId]
    delete sources[ambientId]
    classIdsByName[token] = id
    if (source) sources[id] = source
  }
}
