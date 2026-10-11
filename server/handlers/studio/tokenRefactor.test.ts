/**
 * The rename / remove planner: CSS custom properties across files, modes via
 * selector gates, mentions in TSX strings and Tailwind arbitrary values, and
 * every refusal. Pure over text - the route test commits real files.
 */
import { describe, expect, it } from 'bun:test'
import { planTokenEdits } from './tokenWrite'
import type { TokenCssSource } from './projectTokenIndex'
import type { TokenWorkspaceFile } from './tokenWorkspaceFiles'

const TOKENS_CSS = [
  ':root {',
  '  --color-brand: #0c9ab0;',
  '  --color-brand-2: #0a7c8e;',
  '  --space-md: 16px;',
  '}',
  '',
  "[data-theme='dark'] {",
  '  --color-brand: #5fd3e4;',
  '}',
  '',
].join('\n')

const APP_CSS = ['.btn {', '  color: var(--color-brand);', '  border-color: var( --color-brand-2 );', '}', '.block--brand { margin: var(--space-md); }', ''].join('\n')

const APP_TSX = [
  'export const App = () => <main className="bg-[--color-brand] p-(--space-md)" style={{ color: "var(--color-brand)" }} />',
  '',
].join('\n')

const sources = (extra: TokenCssSource[] = []): TokenCssSource[] => [
  { file: 'src/tokens.css', origin: 'project', css: TOKENS_CSS },
  { file: 'src/app.css', origin: 'project', css: APP_CSS },
  ...extra,
]
const workspace = (): TokenWorkspaceFile[] => [
  { file: 'src/tokens.css', text: TOKENS_CSS },
  { file: 'src/app.css', text: APP_CSS },
  { file: 'src/App.tsx', text: APP_TSX },
]

function textOf(plan: ReturnType<typeof planTokenEdits>, file: string): string | undefined {
  if (!plan.ok) throw new Error(plan.message)
  return plan.files.find((f) => f.file === file)?.next
}

describe('planTokenEdits - rename', () => {
  it('moves the declarations of every mode and every mention, and only whole names', () => {
    const plan = planTokenEdits(sources(), [{ op: 'rename', name: '--color-brand', to: '--color-primary' }], workspace())
    expect(textOf(plan, 'src/tokens.css')).toBe(TOKENS_CSS.replaceAll('--color-brand:', '--color-primary:'))
    expect(textOf(plan, 'src/app.css')).toBe(APP_CSS.replace('var(--color-brand)', 'var(--color-primary)'))
    expect(textOf(plan, 'src/App.tsx')).toBe(APP_TSX.replace('[--color-brand]', '[--color-primary]').replace('var(--color-brand)', 'var(--color-primary)'))
    expect(plan.ok && plan.renamed).toEqual([{ name: '--color-brand', to: '--color-primary', mentions: 5, files: 3 }])
  })

  it('refuses a name that is already declared', () => {
    expect(planTokenEdits(sources(), [{ op: 'rename', name: '--color-brand', to: '--color-brand-2' }], workspace())).toMatchObject({ ok: false, code: 'already-declared' })
  })

  it('refuses a name already used in source without being declared', () => {
    const ws = [...workspace(), { file: 'src/x.tsx', text: 'const a = "var(--elsewhere)"\n' }]
    expect(planTokenEdits(sources(), [{ op: 'rename', name: '--color-brand', to: '--elsewhere' }], ws)).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('refuses a token a package declares', () => {
    const pkg: TokenCssSource = { file: '@acme/ui/dist/style.css', origin: 'package', css: ':root{--pkg-gap:4px}' }
    expect(planTokenEdits(sources([pkg]), [{ op: 'rename', name: '--pkg-gap', to: '--gap' }], workspace())).toMatchObject({ ok: false, code: 'read-only-source' })
  })

  it('refuses an unknown token', () => {
    expect(planTokenEdits(sources(), [{ op: 'rename', name: '--nope', to: '--x' }], workspace())).toMatchObject({ ok: false, code: 'no-such-token' })
  })

  it('must be the only edit in its request', () => {
    const plan = planTokenEdits(
      sources(),
      [
        { op: 'rename', name: '--color-brand', to: '--color-primary' },
        { op: 'set', name: '--space-md', value: '8px' },
      ],
      workspace(),
    )
    expect(plan).toMatchObject({ ok: false, code: 'invalid-input', entryIndex: 0 })
  })

  it('keeps CRLF line endings byte for byte', () => {
    const crlf = TOKENS_CSS.replaceAll('\n', '\r\n')
    const plan = planTokenEdits(
      [{ file: 'src/tokens.css', origin: 'project', css: crlf }],
      [{ op: 'rename', name: '--space-md', to: '--space-base' }],
      [{ file: 'src/tokens.css', text: crlf }],
    )
    expect(textOf(plan, 'src/tokens.css')).toBe(crlf.replace('--space-md', '--space-base'))
  })
})

describe('planTokenEdits - remove', () => {
  it('removes the declarations of an unused token', () => {
    const appWithoutReader = APP_CSS.replace('  border-color: var( --color-brand-2 );\n', '')
    const ws = workspace().map((file) => (file.file === 'src/app.css' ? { ...file, text: appWithoutReader } : file))
    const plan = planTokenEdits(sources(), [{ op: 'remove', name: '--color-brand-2' }], ws)
    expect(textOf(plan, 'src/tokens.css')).toBe(TOKENS_CSS.replace('  --color-brand-2: #0a7c8e;\n', ''))
  })

  it('removes the dark-mode block when the token was its only declaration', () => {
    const plan = planTokenEdits(
      [{ file: 'src/tokens.css', origin: 'project', css: TOKENS_CSS }],
      [{ op: 'remove', name: '--color-brand' }],
      [{ file: 'src/tokens.css', text: TOKENS_CSS }],
    )
    expect(textOf(plan, 'src/tokens.css')).toBe([':root {', '  --color-brand-2: #0a7c8e;', '  --space-md: 16px;', '}', ''].join('\n'))
  })

  it('refuses a token that is still used, naming where', () => {
    const plan = planTokenEdits(sources(), [{ op: 'remove', name: '--space-md' }], workspace())
    expect(plan).toMatchObject({ ok: false, code: 'in-use' })
    expect(!plan.ok && plan.details?.declarations).toEqual(['src/app.css:5', 'src/App.tsx:1'])
  })

  it('moves the readers to the replacement and removes the declarations', () => {
    const plan = planTokenEdits(sources(), [{ op: 'remove', name: '--color-brand', replaceWith: '--color-brand-2' }], workspace())
    expect(textOf(plan, 'src/app.css')).toBe(APP_CSS.replace('var(--color-brand)', 'var(--color-brand-2)'))
    expect(textOf(plan, 'src/App.tsx')).toBe(APP_TSX.replace('[--color-brand]', '[--color-brand-2]').replace('var(--color-brand)', 'var(--color-brand-2)'))
    expect(textOf(plan, 'src/tokens.css')).not.toContain('--color-brand:')
    expect(plan.ok && plan.removed).toEqual([{ name: '--color-brand', declarations: 2, movedReaders: 3, replacedWith: '--color-brand-2' }])
  })

  it('refuses a replacement defined in terms of the token being removed', () => {
    const css = ':root {\n  --a: red;\n  --b: var(--a);\n}\n.x { color: var(--a); }\n'
    const plan = planTokenEdits([{ file: 'src/t.css', origin: 'project', css }], [{ op: 'remove', name: '--a', replaceWith: '--b' }], [{ file: 'src/t.css', text: css }])
    expect(plan).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('refuses an undeclared replacement', () => {
    expect(planTokenEdits(sources(), [{ op: 'remove', name: '--space-md', replaceWith: '--ghost' }], workspace())).toMatchObject({ ok: false, code: 'no-such-token' })
  })
})
