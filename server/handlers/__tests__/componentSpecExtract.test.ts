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
})
