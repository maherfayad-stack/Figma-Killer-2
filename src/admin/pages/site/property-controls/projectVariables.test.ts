/**
 * The client-side scan that turns the project's raw stylesheets — the ones
 * already on the client for the canvas (`studioRawCssStores.ts`) — into the
 * inspector's variable catalog.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildVariableCatalog,
  resolveVariableValue,
  scanCssCustomProperties,
} from './projectVariables'

/**
 * Assembled, not written literally: `no-css-var-fallbacks.test.ts` scans
 * every `.ts(x)` under `src/admin` for `var(--name, fallback)`. That gate is
 * about the CSS WE author; this string is the user's stylesheet, which this
 * scanner exists to read. See `varBinding.test.ts` for the same note.
 */
function varExpr(name: string, fallback: string): string {
  return `var(${name},${' '}${fallback})`
}

describe('scanCssCustomProperties', () => {
  it('reads declarations out of :root', () => {
    const found = scanCssCustomProperties(':root { --color-primary: #ef4550; --space-4: 16px; }')
    expect(found.get('--color-primary')).toBe('#ef4550')
    expect(found.get('--space-4')).toBe('16px')
  })

  it('reads declarations outside :root too', () => {
    // A design system routinely puts dark values under a theme selector and
    // component tokens on a component class; those are variables the user can
    // legitimately reference, so the scan is not `:root`-only.
    const found = scanCssCustomProperties(
      "[data-theme='dark'] { --surface: #111; } .btn { --btn-pad: 8px; }",
    )
    expect(found.get('--surface')).toBe('#111')
    expect(found.get('--btn-pad')).toBe('8px')
  })

  it('lets the last declaration win for a repeated name', () => {
    const found = scanCssCustomProperties(':root{--x:1px}:root{--x:2px}')
    expect(found.get('--x')).toBe('2px')
  })

  it('keeps declaration order — a scale is authored small-to-large', () => {
    const found = scanCssCustomProperties(':root{--s-1:4px;--s-2:8px;--s-10:40px}')
    expect([...found.keys()]).toEqual(['--s-1', '--s-2', '--s-10'])
  })

  it('ignores a stylesheet with no custom properties', () => {
    expect(scanCssCustomProperties('.a { color: red }').size).toBe(0)
    expect(scanCssCustomProperties('').size).toBe(0)
  })
})

describe('resolveVariableValue', () => {
  const declarations = new Map([
    ['--base', '20px'],
    ['--alias', 'var(--base)'],
    ['--chain', 'var(--alias)'],
    ['--loop', 'var(--loop)'],
  ])

  it('resolves a chain, not just one level', () => {
    expect(resolveVariableValue('var(--chain)', declarations)).toBe('20px')
  })

  it('falls back to the reference\'s own fallback argument when the link is missing', () => {
    expect(resolveVariableValue(varExpr('--nope', '12px'), declarations)).toBe('12px')
  })

  it('terminates on a cycle instead of hanging the panel', () => {
    expect(resolveVariableValue('var(--loop)', declarations)).toBe('var(--loop)')
  })

  it('passes a literal through untouched', () => {
    expect(resolveVariableValue('1px solid red', declarations)).toBe('1px solid red')
  })
})

describe('buildVariableCatalog', () => {
  const catalog = buildVariableCatalog({
    projectCss: ':root{--color-primary:#ef4550;--space-4:16px;--btn-bg:var(--vendor-accent)}',
    vendorCss: ':root{--vendor-accent:rgb(12 154 176);--color-primary:#000}',
    frameworkCss: ':root{--text-l:20px}',
  })

  function find(name: string) {
    return catalog.find((entry) => entry.name === name)
  }

  it('classifies each entry from its RESOLVED value', () => {
    expect(find('--color-primary')?.kind).toBe('color')
    expect(find('--space-4')?.kind).toBe('length')
    // Declared as `var(--vendor-accent)`; only resolution makes it a colour.
    expect(find('--btn-bg')?.kind).toBe('color')
    expect(find('--btn-bg')?.resolvedValue).toBe('rgb(12 154 176)')
  })

  it('labels each entry with the bundle it came from', () => {
    expect(find('--space-4')?.source).toBe('project')
    expect(find('--vendor-accent')?.source).toBe('vendor')
    expect(find('--text-l')?.source).toBe('framework')
  })

  it('does not let a package re-declaration relabel the user\'s own variable', () => {
    // `--color-primary` is declared in BOTH bundles. The user's own
    // stylesheet is the one they will recognise, so it stays "Project" and
    // keeps its own value.
    expect(find('--color-primary')?.source).toBe('project')
    expect(find('--color-primary')?.resolvedValue).toBe('#ef4550')
    expect(catalog.filter((entry) => entry.name === '--color-primary')).toHaveLength(1)
  })

  it('is empty for a project with no stylesheets', () => {
    expect(buildVariableCatalog({ projectCss: '', vendorCss: '', frameworkCss: '' })).toEqual([])
  })
})
