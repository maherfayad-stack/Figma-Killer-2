/**
 * The shared token write planner: set / insert plans and every refusal, pure
 * over stylesheet text. (The agent tool and the HTTP route have their own
 * end-to-end tests; this pins the rules both inherit.)
 */
import { describe, expect, it } from 'bun:test'
import { planTokenEdits } from './tokenWrite'
import type { TokenCssSource } from './projectTokenIndex'

const src = (file: string, css: string, origin: TokenCssSource['origin'] = 'project'): TokenCssSource => ({ file, origin, css })

const INDEX_CSS = [
  ':root {',
  '  --color-brand: #0c9ab0;',
  '  --space-md: 16px;',
  '}',
  '',
  "[data-theme='dark'] {",
  '  --color-brand: #5fd3e4;',
  '}',
  '',
].join('\n')

function nextOf(plan: ReturnType<typeof planTokenEdits>, file = 'src/index.css'): string {
  if (!plan.ok) throw new Error(plan.message)
  return plan.files.find((f) => f.file === file)!.next
}

describe('planTokenEdits - set', () => {
  it('edits the declaration of the requested mode and leaves the others', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [
      { op: 'set', name: '--color-brand', value: '#ef4550' },
      { op: 'set', name: '--color-brand', value: '#ff8a93', target: 'dark' },
    ])
    expect(nextOf(plan)).toBe(INDEX_CSS.replace('#0c9ab0', '#ef4550').replace('#5fd3e4', '#ff8a93'))
  })

  it('edits an explicit attribute gate the same way', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [
      { op: 'set', name: '--color-brand', value: '#111111', target: { kind: 'attr', attr: 'data-theme', value: 'dark' } },
    ])
    expect(nextOf(plan)).toBe(INDEX_CSS.replace('#5fd3e4', '#111111'))
  })

  it('lets an explicit breakpoint target edit a responsive override the shorthand refuses', () => {
    const css = `${INDEX_CSS}@media (min-width: 768px) {\n  :root {\n    --space-md: 24px;\n  }\n}\n`
    const shorthand = planTokenEdits([src('src/index.css', css)], [{ op: 'set', name: '--space-md', value: '20px' }])
    expect(shorthand).toMatchObject({ ok: false, code: 'ambiguous-declaration' })

    const explicit = planTokenEdits([src('src/index.css', css)], [
      { op: 'set', name: '--space-md', value: '28px', target: { kind: 'media', query: '(min-width: 768px)' } },
    ])
    expect(nextOf(explicit)).toBe(css.replace('24px', '28px'))
  })

  it('refuses a package-owned token and points at the override', () => {
    const plan = planTokenEdits([src('pkg/ds.css', ':root{--color-brand:#000}', 'package')], [{ op: 'set', name: '--color-brand', value: '#fff' }])
    expect(plan).toMatchObject({ ok: false, code: 'read-only-source' })
    expect((plan as { remedy?: string }).remedy).toContain('insert')
  })

  it('names the missing mode instead of editing the other one', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [{ op: 'set', name: '--space-md', value: '8px', target: 'dark' }])
    expect(plan).toMatchObject({ ok: false, code: 'no-such-token' })
    expect((plan as { message: string }).message).toContain('has a light value but no dark declaration')
  })

  it('refuses a token two project stylesheets both declare, listing both places', () => {
    const plan = planTokenEdits([src('src/a.css', ':root{--x:1px}'), src('src/b.css', ':root{--x:2px}')], [{ op: 'set', name: '--x', value: '3px' }])
    expect(plan).toMatchObject({ ok: false, code: 'ambiguous-declaration', details: { declarations: ['src/a.css:1', 'src/b.css:1'] } })
  })

  it('is all-or-nothing and names the failing entry', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [
      { op: 'set', name: '--space-md', value: '8px' },
      { op: 'set', name: '--nope', value: '1px' },
    ])
    expect(plan).toMatchObject({ ok: false, code: 'no-such-token', entryIndex: 1 })
  })

  it('refuses a duplicate entry and an unsafe value', () => {
    expect(planTokenEdits([src('src/index.css', INDEX_CSS)], [
      { op: 'set', name: '--space-md', value: '8px' },
      { op: 'set', name: '--space-md', value: '9px' },
    ])).toMatchObject({ ok: false, code: 'invalid-input', entryIndex: 1 })
    expect(planTokenEdits([src('src/index.css', INDEX_CSS)], [{ op: 'set', name: '--space-md', value: '1px; color: red' }])).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('reports an unchanged value without planning a write', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [{ op: 'set', name: '--space-md', value: '16px' }])
    expect(plan).toMatchObject({ ok: true, files: [], unchanged: [{ name: '--space-md', target: 'light' }] })
  })
})

describe('planTokenEdits - insert', () => {
  it('declares a new token beside its siblings in the file that holds them', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [{ op: 'insert', name: '--space-lg', value: '24px' }])
    expect(nextOf(plan)).toBe(INDEX_CSS.replace('  --space-md: 16px;\n', '  --space-md: 16px;\n  --space-lg: 24px;\n'))
    expect(plan).toMatchObject({ ok: true, inserted: [{ name: '--space-lg', target: 'light', file: 'src/index.css' }] })
  })

  it('adds a mode to an existing token by declaring it under a new gate', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [
      { op: 'insert', name: '--space-md', value: '12px', target: { kind: 'attr', attr: 'data-density', value: 'compact' } },
    ])
    expect(nextOf(plan)).toBe(`${INDEX_CSS}\n[data-density="compact"] {\n  --space-md: 12px;\n}\n`)
  })

  it('overrides a package token in the project stylesheet instead of editing the package', () => {
    const sources = [src('pkg/ds.css', ':root{--ds-accent:#000}', 'package'), src('src/index.css', INDEX_CSS)]
    const plan = planTokenEdits(sources, [{ op: 'insert', name: '--ds-accent', value: '#f00' }])
    expect(plan).toMatchObject({ ok: true, files: [{ file: 'src/index.css' }] })
    expect(nextOf(plan)).toContain('--ds-accent: #f00;')
  })

  it('refuses to overwrite a token the project already declares for that mode', () => {
    expect(planTokenEdits([src('src/index.css', INDEX_CSS)], [{ op: 'insert', name: '--space-md', value: '1px' }])).toMatchObject({ ok: false, code: 'already-declared' })
  })

  it('refuses when the project has no global stylesheet', () => {
    expect(planTokenEdits([src('pkg/ds.css', ':root{--a:1px}', 'package')], [{ op: 'insert', name: '--b', value: '1px' }])).toMatchObject({ ok: false, code: 'no-project-stylesheet' })
  })

  it('never declares a token in a CSS module', () => {
    const plan = planTokenEdits([src('src/Card.module.css', '.card{color:red}')], [{ op: 'insert', name: '--b', value: '1px' }])
    expect(plan).toMatchObject({ ok: false, code: 'no-project-stylesheet' })
  })

  it('needs a concrete gate for a new declaration, not the dark shorthand', () => {
    expect(planTokenEdits([src('src/index.css', INDEX_CSS)], [{ op: 'insert', name: '--x', value: '1px', target: 'dark' }])).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('declares into @theme for a Tailwind namespace when the file already has one', () => {
    const css = '@import "tailwindcss";\n@theme {\n  --color-brand: #0c9ab0;\n}\n'
    const plan = planTokenEdits([src('src/app.css', css)], [{ op: 'insert', name: '--color-accent', value: '#f00' }])
    expect(nextOf(plan, 'src/app.css')).toBe(css.replace('  --color-brand: #0c9ab0;\n', '  --color-brand: #0c9ab0;\n  --color-accent: #f00;\n'))
  })

  it('composes a set and an insert in one file', () => {
    const plan = planTokenEdits([src('src/index.css', INDEX_CSS)], [
      { op: 'set', name: '--space-md', value: '20px' },
      { op: 'insert', name: '--space-lg', value: '24px' },
    ])
    expect(nextOf(plan)).toBe(INDEX_CSS.replace('--space-md: 16px;', '--space-md: 20px;\n  --space-lg: 24px;'))
  })
})
