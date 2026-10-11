/**
 * CT-6 - a Tailwind v4 `@theme` variable is also the utility classes that read
 * it. Editing its value is the ordinary token write; renaming it moves the
 * classes too (or refuses, naming why); removing it counts the classes as
 * readers. Pure over text - the route test (`tokenThemeRoutes.test.ts`)
 * commits real files and undoes them.
 *
 * The fixture is a bakery storefront, nothing like the eSIM corpus the
 * original token tests grew from.
 */
import { describe, expect, it } from 'bun:test'
import { planTokenEdits } from './tokenWrite'
import { buildTokenCatalog } from './tokenCatalog'
import type { PlannedTokenFile, TokenWritePlan } from './tokenWriteTypes'
import type { TokenCssSource } from './projectTokenIndex'
import type { TokenWorkspaceFile } from './tokenWorkspaceFiles'

const THEME_CSS = [
  '@import "tailwindcss";',
  '',
  '/* storefront palette */',
  '@theme {',
  '  --color-crust: #c58940;',
  '  --color-crust-dark: #8a5a1f;',
  '  --color-cream: #fff7e8;',
  '  --color-sprinkle: #ff44aa;',
  '  --radius-card: 14px;',
  '  --font-display: "Fraunces", serif;',
  '  --text-hero: 3rem;',
  '  --text-hero--line-height: 1.1;',
  '  --spacing-gutter: 2rem;',
  '  --breakpoint-3xl: 120rem;',
  '  --shadow-lift: 0 4px 12px rgb(0 0 0 / 0.2);',
  '}',
  '',
  ':root {',
  '  --brand-glow: 0 0 8px #fff;',
  '}',
  '',
].join('\n')

const MENU_TSX = [
  "import { cn } from './cn'",
  '// the bg-crust hero stays a comment',
  'export function Menu({ hot, tone }: { hot: boolean; tone: string }) {',
  '  return (',
  '    <section className="bg-crust text-cream hover:border-crust/50 md:!bg-crust rounded-card">',
  '      <p>bg-crust is only words here</p>',
  "      <a className={cn('bg-crust-dark p-4', hot && \"text-crust\")} />",
  '      <b className={`bg-crust ${hot ? "shadow-lift" : ""}`} />',
  '      <i className={`bg-${tone} font-display`} />',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n')

const SITE_CSS = ['.hero {', '  @apply bg-crust rounded-card;', '}', '.bg-crust-sample { color: red; }', '.bg-crust { color: blue; }', ''].join('\n')

const sources = (): TokenCssSource[] => [{ file: 'src/theme.css', origin: 'project', css: THEME_CSS }]
const workspace = (extra: TokenWorkspaceFile[] = []): TokenWorkspaceFile[] => [
  { file: 'src/theme.css', text: THEME_CSS },
  { file: 'src/Menu.tsx', text: MENU_TSX },
  { file: 'src/site.css', text: SITE_CSS },
  ...extra,
]

function planned(plan: TokenWritePlan | { ok: false; message: string }): TokenWritePlan {
  if (!plan.ok) throw new Error(`expected a plan, got a refusal: ${plan.message}`)
  return plan
}
const nextOf = (plan: TokenWritePlan, file: string): string => (plan.files.find((entry: PlannedTokenFile) => entry.file === file) ?? { next: '(not written)' }).next

describe('@theme value edit', () => {
  it('rewrites the one declaration inside @theme and keeps every other byte', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'set', name: '--color-crust', value: '#b5762e' }]))
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]!.next).toBe(THEME_CSS.replace('--color-crust: #c58940;', '--color-crust: #b5762e;'))
    expect(plan.changed).toEqual([{ name: '--color-crust', target: 'light', file: 'src/theme.css', line: 5, from: '#c58940', to: '#b5762e' }])
  })

  it('does not mistake the compiled echo of an @theme variable for a second, read-only source', () => {
    const compiled: TokenCssSource = { file: 'compiled styles', origin: 'compiled', css: '@layer theme {\n  :root, :host {\n    --color-crust: #c58940;\n    --color-cream: #fff7e8;\n  }\n}\n.bg-crust { background-color: var(--color-crust); }\n' }
    const catalog = buildTokenCatalog([compiled, ...sources()])
    const crust = catalog.tokens.find((token) => token.name === '--color-crust')!
    expect(crust.decls.map((decl) => decl.origin)).toEqual(['project'])
    expect(catalog.collections.find((collection) => collection.id === crust.collection)!.editable).toBe(true)
    // ...and the edit lands on the project's @theme, not a refusal about compiled output.
    expect(planTokenEdits([compiled, ...sources()], [{ op: 'set', name: '--color-crust', value: '#000' }])).toMatchObject({ ok: true })
  })

  it('keeps a compiled declaration that no project @theme owns (Sass or PostCSS output stays read-only)', () => {
    const compiled: TokenCssSource = { file: 'compiled styles', origin: 'compiled', css: ':root { --legacy: 1px; }' }
    const catalog = buildTokenCatalog([compiled, ...sources()])
    expect(catalog.tokens.find((token) => token.name === '--legacy')!.decls[0]!.origin).toBe('compiled')
  })
})

describe('@theme rename moves the utility classes', () => {
  it('renames the declaration, the var() reads and every class that spells the colour, nothing else', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--color-crust', to: '--color-toast' }], workspace()))
    expect(nextOf(plan, 'src/theme.css')).toBe(THEME_CSS.replace('--color-crust: #c58940;', '--color-toast: #c58940;'))
    expect(nextOf(plan, 'src/Menu.tsx')).toBe(
      MENU_TSX.replace('bg-crust text-cream hover:border-crust/50 md:!bg-crust', 'bg-toast text-cream hover:border-toast/50 md:!bg-toast')
        .replace('hot && "text-crust"', 'hot && "text-toast"')
        .replace('`bg-crust ${', '`bg-toast ${'),
    )
    expect(nextOf(plan, 'src/site.css')).toBe(SITE_CSS.replace('@apply bg-crust rounded-card;', '@apply bg-toast rounded-card;'))
    // 1 declaration + 3 + 1 + 1 classes in Menu.tsx + 1 @apply
    expect(plan.renamed).toEqual([{ name: '--color-crust', to: '--color-toast', mentions: 1 + 5 + 1, files: 3, unfollowed: ['src/Menu.tsx:9'] }])
  })

  it('leaves a longer name alone: bg-crust-dark is another colour, not bg-crust', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--color-crust', to: '--color-toast' }], workspace()))
    expect(nextOf(plan, 'src/Menu.tsx')).toContain("cn('bg-crust-dark p-4'")
    expect(nextOf(plan, 'src/theme.css')).toContain('--color-crust-dark: #8a5a1f;')
  })

  it('does not touch words, comments or a stylesheet class the author wrote', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--color-crust', to: '--color-toast' }], workspace()))
    const menu = nextOf(plan, 'src/Menu.tsx')
    expect(menu).toContain('// the bg-crust hero stays a comment')
    expect(menu).toContain('<p>bg-crust is only words here</p>')
    expect(nextOf(plan, 'src/site.css')).toContain('.bg-crust { color: blue; }')
    expect(nextOf(plan, 'src/site.css')).toContain('.bg-crust-sample')
  })

  it('reports a class built at runtime instead of leaving it silently dangling', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--color-crust', to: '--color-toast' }], workspace()))
    expect(plan.renamed[0]!.unfollowed).toEqual(['src/Menu.tsx:9'])
  })

  it('moves a radius, a shadow and a font family by their own utilities', () => {
    const radius = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--radius-card', to: '--radius-tile' }], workspace()))
    expect(nextOf(radius, 'src/Menu.tsx')).toContain('md:!bg-crust rounded-tile">')
    expect(nextOf(radius, 'src/site.css')).toContain('@apply bg-crust rounded-tile;')
    const shadow = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--shadow-lift', to: '--shadow-float' }], workspace()))
    expect(nextOf(shadow, 'src/Menu.tsx')).toContain('"shadow-float"')
    const font = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--font-display', to: '--font-serif' }], workspace()))
    expect(nextOf(font, 'src/Menu.tsx')).toContain('font-serif')
  })

  it('moves the companion variables Tailwind pairs with a size by name', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--text-hero', to: '--text-banner' }], workspace()))
    expect(nextOf(plan, 'src/theme.css')).toContain('--text-banner: 3rem;\n  --text-banner--line-height: 1.1;')
  })

  it('renames a variable that is not in a utility namespace like any custom property', () => {
    const plan = planned(planTokenEdits(sources(), [{ op: 'rename', name: '--brand-glow', to: '--brand-halo' }], workspace()))
    expect(nextOf(plan, 'src/theme.css')).toContain('--brand-halo: 0 0 8px #fff;')
    expect(plan.renamed[0]!.unfollowed).toEqual([])
  })
})

describe('@theme rename refusals', () => {
  const rename = (name: string, to: string, extra: TokenWorkspaceFile[] = []) => planTokenEdits(sources(), [{ op: 'rename', name, to }], workspace(extra))

  it('refuses the namespaces whose names are read by too many utilities or variants to follow', () => {
    expect(rename('--spacing-gutter', '--spacing-edge')).toMatchObject({ ok: false, code: 'rename-blocked' })
    expect(rename('--breakpoint-3xl', '--breakpoint-wide')).toMatchObject({ ok: false, code: 'rename-blocked' })
  })

  it('refuses a new name that leaves the namespace: the prefix is what makes it a class', () => {
    const plan = rename('--color-crust', '--crust')
    expect(plan).toMatchObject({ ok: false, code: 'rename-blocked' })
    expect(plan.ok ? '' : plan.message).toContain('--color-')
  })

  it('refuses a companion on its own', () => {
    expect(rename('--text-hero--line-height', '--text-hero--leading')).toMatchObject({ ok: false, code: 'rename-blocked' })
  })

  it('refuses when two namespaces would spell the same class (text-lg is a colour and a size)', () => {
    const css = '@theme {\n  --color-lg: #111;\n  --text-lg: 2rem;\n}\n'
    const plan = planTokenEdits([{ file: 'src/t.css', origin: 'project', css }], [{ op: 'rename', name: '--color-lg', to: '--color-big' }], [{ file: 'src/t.css', text: css }])
    expect(plan).toMatchObject({ ok: false, code: 'rename-blocked' })
  })

  it('refuses a new name whose classes are already in use, and a name already declared', () => {
    const used: TokenWorkspaceFile = { file: 'src/Other.tsx', text: 'export const x = <i className="bg-toast" />\n' }
    expect(rename('--color-crust', '--color-toast', [used])).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(rename('--color-crust', '--color-cream')).toMatchObject({ ok: false, code: 'already-declared' })
  })

  it('refuses when a file type the undo journal cannot restore spells the class', () => {
    const html: TokenWorkspaceFile = { file: 'public/promo.html', text: '<div class="bg-crust">sale</div>\n' }
    const plan = rename('--color-crust', '--color-toast', [html])
    expect(plan).toMatchObject({ ok: false, code: 'read-only-source' })
    expect(plan.ok ? [] : plan.details?.declarations).toEqual(['public/promo.html'])
  })

  it('a value edit of a refused-for-rename variable is still allowed', () => {
    expect(planTokenEdits(sources(), [{ op: 'set', name: '--spacing-gutter', value: '3rem' }])).toMatchObject({ ok: true })
  })
})

describe('@theme remove counts classes as readers', () => {
  const remove = (name: string, replaceWith?: string, extra: TokenWorkspaceFile[] = []) =>
    planTokenEdits(sources(), [{ op: 'remove', name, ...(replaceWith ? { replaceWith } : {}) }], workspace(extra))

  it('refuses removing a colour a class still uses', () => {
    const plan = remove('--color-crust')
    expect(plan).toMatchObject({ ok: false, code: 'in-use' })
  })

  it('moves the classes to a replacement in the same namespace', () => {
    const plan = planned(remove('--color-crust', '--color-cream'))
    expect(nextOf(plan, 'src/Menu.tsx')).toContain('className="bg-cream text-cream hover:border-cream/50 md:!bg-cream rounded-card"')
    expect(nextOf(plan, 'src/theme.css')).not.toContain('--color-crust:')
    expect(plan.removed[0]).toMatchObject({ name: '--color-crust', replacedWith: '--color-cream' })
  })

  it('refuses a replacement in another namespace when classes would have nothing to become', () => {
    expect(remove('--color-crust', '--radius-card')).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('removes an unused variable outright, with nothing to replace', () => {
    const plan = planned(remove('--color-sprinkle'))
    expect(nextOf(plan, 'src/theme.css')).toBe(THEME_CSS.replace('  --color-sprinkle: #ff44aa;\n', ''))
  })

  it('cannot tell whether a spacing or breakpoint variable is used, so it does not remove it', () => {
    expect(remove('--spacing-gutter')).toMatchObject({ ok: false, code: 'remove-blocked' })
    expect(remove('--breakpoint-3xl')).toMatchObject({ ok: false, code: 'remove-blocked' })
  })
})
