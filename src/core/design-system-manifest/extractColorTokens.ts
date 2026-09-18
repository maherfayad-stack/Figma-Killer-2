/**
 * Builds `vendor/alm-design-system/dist/tokens.generated.json` — the design
 * system's colour palette as data, so the editor can show swatches without
 * parsing CSS in the browser and without the project having anything installed.
 *
 * Scope is the two things a colour picker can actually paint: every raw
 * `--color-*` token and every semantic `--background-*` / `--text-*` /
 * `--border-*` / `--icon-*` token. The gradient, elevation, spacing, radius and
 * typography families are not colours and are not here.
 *
 * Two decisions worth knowing:
 *
 *  - **Values are resolved.** A semantic token is declared as
 *    `var(--color-light)`, which no swatch can paint, so `var()` references are
 *    resolved within the token set before recording. `--background-base-default`
 *    therefore reads `#FFFFFF` light / `#1C1C1C` dark — which is also what the
 *    cascade produces, because the raw token it points at is the thing the dark
 *    theme redeclares.
 *  - **Dark comes from `:root[data-theme="dark"]` only.** The stylesheet ALSO
 *    carries a `@media (prefers-color-scheme: dark)` copy of the same block;
 *    reading one of the two is enough, and the explicit attribute selector is
 *    the one Studio's canvas drives (`data-theme` on the frame). A token the
 *    dark block does not redeclare keeps its light value.
 *
 * Node/Bun only — see `vendorRoot.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesignSystemColorToken } from './designSystemSchemas'
import { VENDOR_DESIGN_SYSTEM_DIR } from './vendorRoot'

const TOKENS_DIR_REL = 'src/tokens'

/** The custom-property families a swatch can paint. Order matters: first match wins. */
const COLOR_PREFIXES = ['--color-', '--background-', '--text-', '--border-', '--icon-'] as const

/**
 * Comment heading (a `── Neutral ──` CSS comment) → the group name the editor shows.
 *
 * The design system writes one such heading above each family in
 * `colors.css` / `semantic.css`, which makes the grouping the design system's
 * own rather than Studio's guess. Two upstream headings collapse into one group
 * ("Background" and "Brand backgrounds" are both semantic backgrounds) because
 * the distinction is about where the value comes from, not what it is.
 */
const GROUP_FOR_HEADING: Record<string, string> = {
  Neutral: 'Neutral',
  Aqua: 'Aqua',
  Coral: 'Coral',
  Forest: 'Forest',
  Butter: 'Butter',
  Purple: 'Purple',
  Brand: 'Brand',
  'Gradient colors': 'Gradients',
  Background: 'Semantic background',
  'Brand backgrounds': 'Semantic background',
  Text: 'Semantic text',
  Border: 'Semantic border',
  Icon: 'Semantic icon',
}

/** Fallback grouping for a semantic token under an upstream heading this file does not know. */
const GROUP_FOR_PREFIX: Record<string, string> = {
  '--background-': 'Semantic background',
  '--text-': 'Semantic text',
  '--border-': 'Semantic border',
  '--icon-': 'Semantic icon',
}

interface Declaration {
  name: string
  value: string
  heading: string
}

/** Comment or custom-property declaration, in source order. */
const COMMENT_OR_DECLARATION = /\/\*([\s\S]*?)\*\/|(--[\w-]+)\s*:\s*([^;]+);/g

/** `── Neutral ──` inside a comment — the upstream family heading marker. */
const FAMILY_HEADING = /──\s*(.+?)\s*──/

/** A rule whose selector is exactly `sel`, ignoring nested at-rules (see the module doc). */
function declarationsOfRootBlock(css: string, selector: string): Declaration[] {
  const out: Declaration[] = []
  for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // The captured "selector" also holds whatever preceded it since the last
    // brace — the file's own banner comment, blank lines — so strip comments
    // before comparing.
    if (block[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim() !== selector) continue
    let heading = ''
    for (const match of block[2]!.matchAll(COMMENT_OR_DECLARATION)) {
      if (match[1] !== undefined) {
        const found = FAMILY_HEADING.exec(match[1])
        if (found) heading = found[1]!.trim()
        continue
      }
      out.push({ name: match[2]!, value: match[3]!.trim(), heading })
    }
  }
  return out
}

/** Resolve `var(--x)` references against `values`, with a cycle/depth guard. */
function resolveValue(raw: string, values: ReadonlyMap<string, string>): string {
  let current = raw
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current.includes('var(')) return current
    const next = current.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name: string) => values.get(name) ?? whole)
    if (next === current) return current
    current = next
  }
  return current
}

function groupFor(declaration: Declaration): string {
  // The three alpha neutrals (`--color-black-50`, `--color-light-40/92`) live
  // under the Neutral heading but are translucent overlays, not surface
  // colours — a swatch grid that mixes them into Neutral reads as a bug.
  if (declaration.heading === 'Neutral' && /^rgba?\(/i.test(declaration.value)) return 'Alpha'
  const mapped = GROUP_FOR_HEADING[declaration.heading]
  if (mapped) return mapped
  for (const [prefix, group] of Object.entries(GROUP_FOR_PREFIX)) {
    if (declaration.name.startsWith(prefix)) return group
  }
  // An upstream `--color-*` family this file has never seen: surface it under
  // its own heading rather than hiding it in a bucket.
  return declaration.heading || 'Other'
}

/**
 * Every paintable colour token in the vendored design system, in stylesheet
 * order (raw palette first, then semantics).
 */
export function extractColorTokens(): DesignSystemColorToken[] {
  const dir = join(VENDOR_DESIGN_SYSTEM_DIR, TOKENS_DIR_REL)
  const files = readdirSync(dir).filter((file) => file.endsWith('.css')).sort()

  const light: Declaration[] = []
  const darkValues = new Map<string, string>()
  for (const file of files) {
    const css = readFileSync(join(dir, file), 'utf8')
    light.push(...declarationsOfRootBlock(css, ':root'))
    for (const declaration of declarationsOfRootBlock(css, ':root[data-theme="dark"]')) {
      darkValues.set(declaration.name, declaration.value)
    }
  }

  const lightValues = new Map(light.map((declaration) => [declaration.name, declaration.value]))
  // A token the dark block does not redeclare keeps its light value — the same
  // thing the cascade does.
  const darkLookup = new Map(lightValues)
  for (const [name, value] of darkValues) darkLookup.set(name, value)

  const tokens: DesignSystemColorToken[] = []
  for (const declaration of light) {
    if (!COLOR_PREFIXES.some((prefix) => declaration.name.startsWith(prefix))) continue
    tokens.push({
      name: declaration.name,
      light: resolveValue(declaration.value, lightValues),
      dark: resolveValue(darkValues.get(declaration.name) ?? declaration.value, darkLookup),
      group: groupFor(declaration),
    })
  }
  return tokens
}
