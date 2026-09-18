/**
 * Every module a person can insert must be FINDABLE: a real one-line
 * description, and at least three keywords.
 *
 * Before DS-6 the 39 design-system modules all carried the literal description
 * `"<Name> — @alm-design/design-system"` and no keywords at all, and search was
 * a substring match over `[name, id, category, description]`. Typing "header"
 * found nothing; so did "pill", "row", "toast", "switch" and "divider". The
 * fix is data, and data rots quietly — hence a gate rather than a convention.
 *
 * Deliberately a PURE DATA test. The scoring below is the crudest thing that
 * can answer "does the data point at the right component" — exact name, exact
 * keyword, then progressively weaker matches. The Assets panel's real ranking
 * (`rankAssets`, DS-4) is a different function with its own test; it points at
 * the same `EXPECTED_FIRST_HIT` table, so the two cannot disagree about what
 * "header" should find.
 */
import { describe, expect, it } from 'bun:test'
import { registry, type AnyModuleDefinition } from '@core/module-engine'
import {
  moduleAvailability,
  type ModuleInsertionContext,
} from '@site/panels/AssetsPanel/assetsModel'
import manifestJson from '@modules/alm/manifest.generated.json'
import type { DesignSystemManifest } from '@core/design-system-manifest'
import '@modules/base'
import '@modules/alm/register'

const manifest = manifestJson as DesignSystemManifest

/** A plain page on a plain board — the context almost every insert happens in. */
const PAGE_CONTEXT: ModuleInsertionContext = {
  isVCMode: false,
  activeVcId: null,
  isTemplate: false,
  hasOutlet: false,
}

function studioModules(): AnyModuleDefinition[] {
  return registry.list().filter((mod) => mod.id.startsWith('alm.') || mod.id.startsWith('base.'))
}

function paletteVisibleModules(): AnyModuleDefinition[] {
  return studioModules().filter((mod) => moduleAvailability(mod, PAGE_CONTEXT).kind !== 'hidden')
}

/**
 * Descriptions a gate must reject: the shapes a placeholder takes. A
 * description that merely repeats the module's own name tells a reader
 * nothing they could not already see on the card.
 */
function isPlaceholderDescription(mod: AnyModuleDefinition): boolean {
  const description = (mod.description ?? '').trim()
  if (description === '') return true
  if (description === `${mod.name} module`) return true
  if (description === `${mod.name} component`) return true
  return description.includes('@alm-design/design-system')
}

// ---------------------------------------------------------------------------
// Query → the module it must resolve to
// ---------------------------------------------------------------------------

/**
 * The words people actually type, and the one module each must find.
 *
 * Every row here is a word the OLD search returned nothing for. They are also
 * the rows DS-4's ranking test reuses — keep the two tables identical.
 */
const EXPECTED_FIRST_HIT: ReadonlyArray<readonly [query: string, moduleId: string]> = [
  ['header', 'alm.Navbar'],
  ['pill', 'alm.Chip'],
  ['row', 'alm.Cell'],
  ['toast', 'alm.Snackbar'],
  ['switch', 'alm.Toggle'],
  ['divider', 'alm.Separator'],
  ['wrapper', 'base.container'],
]

/** Crude token match: exact name, exact keyword, prefix, word, substring. */
function score(query: string, mod: AnyModuleDefinition): number {
  const name = mod.name.toLowerCase()
  const keywords = (mod.keywords ?? []).map((keyword) => keyword.toLowerCase())
  if (name === query) return 100
  if (keywords.includes(query)) return 50
  if (name.startsWith(query)) return 25
  if (keywords.some((keyword) => keyword.split(/\s+/).includes(query))) return 10
  if (name.includes(query)) return 5
  if (keywords.some((keyword) => keyword.includes(query))) return 2
  return 0
}

describe('assets search coverage', () => {
  it('registers the design system and the base modules', () => {
    const visible = paletteVisibleModules()
    expect(visible.filter((mod) => mod.id.startsWith('alm.')).length).toBeGreaterThanOrEqual(30)
    expect(visible.some((mod) => mod.id === 'base.container')).toBe(true)
  })

  it('gives every palette-visible module a real description', () => {
    const offenders = paletteVisibleModules()
      .filter(isPlaceholderDescription)
      .map((mod) => mod.id)
    expect(offenders).toEqual([])
  })

  it('gives every palette-visible module at least three keywords', () => {
    const offenders = paletteVisibleModules()
      .filter((mod) => (mod.keywords ?? []).length < 3)
      .map((mod) => `${mod.id} (${(mod.keywords ?? []).length})`)
    expect(offenders).toEqual([])
  })

  it('puts every manifest component in a group', () => {
    const offenders = manifest.components
      .filter((component) => component.group.trim() === '')
      .map((component) => component.name)
    expect(offenders).toEqual([])
  })

  it('resolves each probe query to exactly one best module', () => {
    // Over EVERY registered design-system / base module, not just the
    // palette-visible ones: `Snackbar` and the four other overlay shells are
    // hidden from the insert palette (they are page kinds, not things you
    // place in a flow) and their search data still has to be right — the
    // Properties panel, the DOM panel and the agent all read it.
    const modules = studioModules()
    for (const [query, expectedId] of EXPECTED_FIRST_HIT) {
      const scored = modules
        .map((mod) => ({ id: mod.id, value: score(query, mod) }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))

      expect(scored.length, `"${query}" matched nothing`).toBeGreaterThan(0)
      expect(scored[0]!.id, `"${query}" should find ${expectedId}`).toBe(expectedId)
      // A tie for first place means the data, not the ranking, decides — and
      // whichever module sorts first alphabetically wins by accident.
      const tied = scored.filter((entry) => entry.value === scored[0]!.value)
      expect(tied.map((entry) => entry.id), `"${query}" is a tie`).toEqual([expectedId])
    }
  })
})
