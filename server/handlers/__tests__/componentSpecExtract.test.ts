/**
 * componentSpecExtract — coverage for `extractLocalComponentCatalog`, Track
 * E1's whole-workspace local-component walk (the sibling of
 * `packageManifest.test.ts`'s single-package coverage). Fixtures are a
 * generic, hand-written component tree that shares nothing with the eSIM
 * corpus — `Card`/`Badge`/`Toolbar`-shaped, per `genericRepoShapes.test.ts`'s
 * own discipline (a suite grown from one repo's habits encodes that repo's
 * habits).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject } from '@core/page-parser'
import { extractLocalComponentCatalog } from '../studio/componentSpecExtract'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-spec-extract-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function catalog() {
  const project = createWorkspaceProject(tmpDir)
  return extractLocalComponentCatalog(project, tmpDir)
}

describe('extractLocalComponentCatalog', () => {
  it('finds a named-export function component and classifies its typed props, incl. a named union alias (K3)', () => {
    write(
      'src/components/Card.tsx',
      [
        "export type CardTone = 'neutral' | 'accent'",
        'export interface CardProps {',
        '  title: string',
        '  tone?: CardTone',
        '}',
        'export function Card({ title, tone }: CardProps) {',
        '  return null',
        '}',
      ].join('\n'),
    )

    const specs = catalog()
    const card = specs.find((c) => c.name === 'Card')
    expect(card).toBeDefined()
    expect(card!.file).toBe('src/components/Card.tsx')
    expect(card!.exportName).toBe('Card')
    expect(card!.isDefaultExport).toBe(false)
    expect(card!.props.find((p) => p.name === 'title')?.kind).toEqual({ kind: 'string' })
    expect(card!.props.find((p) => p.name === 'tone')?.kind).toEqual({ kind: 'enum', values: ['neutral', 'accent'] })
  })

  it('finds an arrow-function component typed with React.FC', () => {
    write(
      'src/components/Badge.tsx',
      [
        'import type { FC } from "react"',
        'export interface BadgeProps {',
        '  label: string',
        '}',
        'export const Badge: FC<BadgeProps> = ({ label }) => null',
      ].join('\n'),
    )

    const specs = catalog()
    const badge = specs.find((c) => c.name === 'Badge')
    expect(badge).toBeDefined()
    expect(badge!.props.find((p) => p.name === 'label')?.kind).toEqual({ kind: 'string' })
  })

  it('finds an inline default-exported function component and recovers its name from the file base', () => {
    write(
      'src/components/Toolbar.tsx',
      ['export default function ({ count }: { count: number }) {', '  return null', '}'].join('\n'),
    )

    const specs = catalog()
    const toolbar = specs.find((c) => c.file === 'src/components/Toolbar.tsx')
    expect(toolbar).toBeDefined()
    expect(toolbar!.name).toBe('Toolbar')
    expect(toolbar!.exportName).toBe('default')
    expect(toolbar!.isDefaultExport).toBe(true)
    expect(toolbar!.props.find((p) => p.name === 'count')?.kind).toEqual({ kind: 'number' })
  })

  it('finds `export default Card` where Card is declared separately in the same file (identifier default export)', () => {
    write(
      'src/components/Avatar.tsx',
      [
        'function Avatar({ src }: { src: string }) {',
        '  return null',
        '}',
        'export default Avatar',
      ].join('\n'),
    )

    const specs = catalog()
    const avatar = specs.find((c) => c.file === 'src/components/Avatar.tsx')
    expect(avatar).toBeDefined()
    expect(avatar!.name).toBe('Avatar')
    expect(avatar!.exportName).toBe('default')
    expect(avatar!.isDefaultExport).toBe(true)
    expect(avatar!.props.find((p) => p.name === 'src')?.kind).toEqual({ kind: 'image' })
  })

  it('does NOT double-count a component through a barrel re-export — attributes it to the file that declares it, once', () => {
    write(
      'src/components/Chip.tsx',
      ['export function Chip({ label }: { label: string }) {', '  return null', '}'].join('\n'),
    )
    write('src/components/index.ts', "export { Chip } from './Chip'")

    const specs = catalog()
    const chips = specs.filter((c) => c.name === 'Chip')
    expect(chips.length).toBe(1)
    expect(chips[0]!.file).toBe('src/components/Chip.tsx')
  })

  it('gives an untyped JS component honest, empty props rather than guessing', () => {
    write(
      'src/components/Legacy.jsx',
      ['export function Legacy({ title }) {', '  return null', '}'].join('\n'),
    )

    const specs = catalog()
    const legacy = specs.find((c) => c.name === 'Legacy')
    expect(legacy).toBeDefined()
    expect(legacy!.props).toEqual([])
  })

  it('does not manifest a non-PascalCase or non-component export', () => {
    write(
      'src/utils/format.ts',
      ['export function formatPrice(value: number) {', '  return String(value)', '}', 'export const MAX_ITEMS = 10'].join('\n'),
    )

    const specs = catalog()
    expect(specs.some((c) => c.name === 'formatPrice')).toBe(false)
    expect(specs.some((c) => c.name === 'MAX_ITEMS')).toBe(false)
  })

  it('drops a handler prop rather than stubbing it, same as the package-extraction path', () => {
    write(
      'src/components/Button.tsx',
      [
        'export interface ButtonProps {',
        '  label: string',
        '  onPress?: () => void',
        '}',
        'export function Button({ label, onPress }: ButtonProps) {',
        '  return null',
        '}',
      ].join('\n'),
    )

    const specs = catalog()
    const button = specs.find((c) => c.name === 'Button')
    expect(button!.props.some((p) => p.name === 'onPress')).toBe(false)
    expect(button!.props.some((p) => p.name === 'label')).toBe(true)
  })

  describe('variant read model (CV-1)', () => {
    it('reports defaults, member source ranges and the css-module binding for an inline union', () => {
      write(
        'src/components/Tag.tsx',
        [
          "import styles from './Tag.module.css'",
          'export interface TagProps {',
          "  tone?: 'info' | 'warn' | 'danger'",
          '  pinned?: boolean',
          '  label: string',
          '}',
          "export function Tag({ tone = 'info', pinned = false, label }: TagProps) {",
          '  return <span className={styles[tone]}>{label}</span>',
          '}',
        ].join('\n'),
      )
      write('src/components/Tag.module.css', '.info { color: blue; }\n.warn { color: orange; }\n')

      const tag = catalog().find((c) => c.name === 'Tag')!
      const tone = tag.props.find((p) => p.name === 'tone')!
      expect(tone.kind).toEqual({ kind: 'enum', values: ['info', 'warn', 'danger'] })
      expect(tone.defaultValue).toBe('info')
      expect(tone.unionHome).toBe('inline')
      // Each member points at its own literal (line 3: `  tone?: 'info' | …`).
      expect(tone.members?.map((m) => [m.name, m.origin?.file, m.origin?.line, m.origin?.column])).toEqual([
        ['info', 'src/components/Tag.tsx', 3, 10],
        ['warn', 'src/components/Tag.tsx', 3, 19],
        ['danger', 'src/components/Tag.tsx', 3, 28],
      ])
      expect(tone.binding?.kind).toBe('css-module-class')

      const pinned = tag.props.find((p) => p.name === 'pinned')!
      expect(pinned.defaultValue).toBe(false)
      // Declared, but never read: the model says so instead of staying silent.
      expect(pinned.binding).toMatchObject({ kind: 'opaque' })
      // A string prop is not a variant axis: none of the variant fields.
      const label = tag.props.find((p) => p.name === 'label')!
      expect(label.binding).toBeUndefined()
      expect(label.members).toBeUndefined()
      expect(label.defaultValue).toBeUndefined()
    })

    it('calls a union written inside the prop type `inline`', () => {
      write(
        'src/components/Seg.tsx',
        ["export function Seg({ mode }: { mode?: 'a' | 'b' | undefined | null }) {", '  return <i>{mode}</i>', '}'].join('\n'),
      )
      const mode = catalog().find((c) => c.name === 'Seg')!.props[0]!
      // Classification is exactly what it was before the read model: values and order.
      expect(mode.kind).toEqual({ kind: 'enum', values: ['a', 'b'] })
      expect(mode.unionHome).toBe('inline')
      expect(mode.members?.map((m) => m.name)).toEqual(['a', 'b'])
    })

    it('distinguishes a same-file alias from an alias declared in another file', () => {
      write('src/components/sizes.ts', "export type Size = 'sm' | 'md'\n")
      write(
        'src/components/Chip.tsx',
        [
          "import type { Size } from './sizes'",
          "type Tone = 'plain' | 'bold'",
          'export function Chip({ tone, size }: { tone: Tone; size: Size }) {',
          '  return <i>{tone}{size}</i>',
          '}',
        ].join('\n'),
      )

      const chip = catalog().find((c) => c.name === 'Chip')!
      const tone = chip.props.find((p) => p.name === 'tone')!
      const size = chip.props.find((p) => p.name === 'size')!
      expect(tone.unionHome).toBe('same-file-alias')
      expect(tone.members?.[0]?.origin).toMatchObject({ file: 'src/components/Chip.tsx', line: 2 })
      expect(size.unionHome).toBe('other-file')
      expect(size.members?.[1]?.origin).toMatchObject({ file: 'src/components/sizes.ts', line: 1 })
    })

    it('gives a class component members but no binding (the analyzer reads function components only)', () => {
      write(
        'src/components/Old.tsx',
        [
          "import { Component } from 'react'",
          "export class Old extends Component<{ tone: 'a' | 'b' }> {",
          '  render() { return null }',
          '}',
        ].join('\n'),
      )
      const tone = catalog().find((c) => c.name === 'Old')!.props[0]!
      expect(tone.binding).toBeUndefined()
      expect(tone.members?.map((m) => m.name)).toEqual(['a', 'b'])
    })
  })
})

describe('extractLocalComponentCatalog roles', () => {
  it('marks a flat pages/ screen as a page via the detected pagesDir, not only Next route files', () => {
    write('pages/Home.tsx', 'export default function Home() {\n  return <main />\n}')
    write('components/Hero.tsx', 'export default function Hero() {\n  return <section />\n}')
    const project = createWorkspaceProject(tmpDir)
    const roles = Object.fromEntries(extractLocalComponentCatalog(project, tmpDir, { pagesDir: 'pages' }).map((c) => [c.name, c.role]))
    expect(roles).toEqual({ Home: 'page', Hero: 'component' })
  })

  it('marks a children-only context wrapper as a provider, never a component with real markup', () => {
    write(
      'components/LanguageProvider.tsx',
      [
        "import { createContext } from 'react'",
        'const Ctx = createContext<string>("en")',
        'export function LanguageProvider({ children }: { children: React.ReactNode }) {',
        '  const lang = "en"',
        '  return <Ctx.Provider value={lang}>{children}</Ctx.Provider>',
        '}',
      ].join('\n'),
    )
    write(
      'components/Shell.tsx',
      'export const Shell = ({ children }: { children: React.ReactNode }) => (\n  <div className="shell">{children}</div>\n)',
    )
    write(
      'components/Providers.tsx',
      'export const Providers = ({ children }) => <A.Provider value={1}><BProvider>{children}</BProvider></A.Provider>',
    )
    const roles = Object.fromEntries(catalog().map((c) => [c.name, c.role]))
    expect(roles).toEqual({ LanguageProvider: 'provider', Shell: 'component', Providers: 'provider' })
  })
})

describe('extractLocalComponentCatalog - lists and the index into them', () => {
  it('classifies T[], Array<T> and readonly T[] as a collection', () => {
    write(
      'src/components/List.tsx',
      [
        'export function List({ items, rows, cells }: { items: string[]; rows?: Array<{ id: string }>; cells?: readonly number[] }) {',
        '  return null',
        '}',
      ].join('\n'),
    )
    const list = catalog().find((c) => c.name === 'List')!
    expect(list.props.map((p) => [p.name, p.kind.kind])).toEqual([
      ['items', 'collection'],
      ['rows', 'collection'],
      ['cells', 'collection'],
    ])
  })

  it('marks a selection-named number next to the one list as an index into it', () => {
    write(
      'src/components/Tabs.tsx',
      [
        'export function Tabs({ items, activeIndex = 0, gap }: { items: string[]; activeIndex?: number; gap?: number }) {',
        '  return null',
        '}',
      ].join('\n'),
    )
    const tabs = catalog().find((c) => c.name === 'Tabs')!
    expect(tabs.props.find((p) => p.name === 'activeIndex')?.kind).toEqual({ kind: 'collectionIndex', collection: 'items' })
    // A number that does not name a selection stays a number.
    expect(tabs.props.find((p) => p.name === 'gap')?.kind).toEqual({ kind: 'number' })
  })

  it('leaves the number alone when two unrelated lists leave no honest choice', () => {
    write(
      'src/components/Grid.tsx',
      ['export function Grid({ a, b, value }: { a: string[]; b: string[]; value?: number }) {', '  return null', '}'].join('\n'),
    )
    const grid = catalog().find((c) => c.name === 'Grid')!
    expect(grid.props.find((p) => p.name === 'value')?.kind).toEqual({ kind: 'number' })
  })
})
