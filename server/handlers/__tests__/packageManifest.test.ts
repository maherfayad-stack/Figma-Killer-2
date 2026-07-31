/**
 * packageManifest — WS-3.1 coverage. Fixtures are tiny, hand-written stand-in
 * `.d.ts`/`.tsx` packages written directly into each fixture's own
 * `node_modules/` — no network install, same discipline as
 * `styleCompile.test.ts`. None of these fixtures share anything with the
 * eSIM corpus (generic `Button`/`Badge`/`Avatar`/`Chip` component shapes),
 * per `genericRepoShapes.test.ts`'s discipline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildPackageManifest, classifyPropType } from '../studio/packageManifest'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-manifest-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function installDts(pkgName: string, dtsContents: string, packageJsonExtra: Record<string, unknown> = {}): void {
  write(`node_modules/${pkgName}/package.json`, JSON.stringify({ name: pkgName, version: '1.0.0', types: 'index.d.ts', ...packageJsonExtra }))
  write(`node_modules/${pkgName}/index.d.ts`, dtsContents)
}

describe('buildPackageManifest — .d.ts extraction (Tier 1: React.FC + interface)', () => {
  it('extracts a string-literal union prop as PropKind.enum', () => {
    installDts(
      'acme-ui',
      [
        'export interface ButtonProps {',
        "  variant?: 'primary' | 'ghost' | 'danger'",
        '  label: string',
        '}',
        'export declare const Button: React.FC<ButtonProps>',
      ].join('\n'),
    )

    const { components, warnings } = buildPackageManifest(tmpDir, 'acme-ui')
    expect(warnings).toEqual([])
    const button = components.find((c) => c.name === 'Button')
    expect(button).toBeDefined()
    expect(button!.props.find((p) => p.name === 'variant')?.kind).toEqual({
      kind: 'enum',
      values: ['primary', 'ghost', 'danger'],
    })
    expect(button!.props.find((p) => p.name === 'label')?.kind).toEqual({ kind: 'string' })
  })

  it('extracts a ReactNode prop as PropKind.node', () => {
    installDts(
      'acme-ui',
      [
        "import type { ReactNode } from 'react'",
        'export interface CardProps {',
        '  icon?: ReactNode',
        '}',
        'export declare function Card(props: CardProps): JSX.Element',
      ].join('\n'),
    )

    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const card = components.find((c) => c.name === 'Card')
    expect(card).toBeDefined()
    expect(card!.props.find((p) => p.name === 'icon')?.kind).toEqual({ kind: 'node' })
  })

  it('drops a handler prop entirely instead of stubbing it', () => {
    installDts(
      'acme-ui',
      [
        'export interface ButtonProps {',
        '  label: string',
        '  onClick?: (event: unknown) => void',
        '}',
        'export declare const Button: React.FC<ButtonProps>',
      ].join('\n'),
    )

    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const button = components.find((c) => c.name === 'Button')
    expect(button).toBeDefined()
    expect(button!.props.some((p) => p.name === 'onClick')).toBe(false)
    expect(button!.props.some((p) => p.name === 'label')).toBe(true)
  })

  it('classifies a string prop named for color as PropKind.color', () => {
    installDts(
      'acme-ui',
      ['export interface BadgeProps {', '  bgColor?: string', '}', 'export declare const Badge: React.FC<BadgeProps>'].join('\n'),
    )
    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const badge = components.find((c) => c.name === 'Badge')
    expect(badge!.props.find((p) => p.name === 'bgColor')?.kind).toEqual({ kind: 'color' })
  })

  it('classifies a string prop named for image as PropKind.image', () => {
    installDts(
      'acme-ui',
      ['export interface AvatarProps {', '  avatarSrc?: string', '}', 'export declare const Avatar: React.FC<AvatarProps>'].join('\n'),
    )
    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const avatar = components.find((c) => c.name === 'Avatar')
    expect(avatar!.props.find((p) => p.name === 'avatarSrc')?.kind).toEqual({ kind: 'image' })
  })

  it('classifies number and boolean props', () => {
    installDts(
      'acme-ui',
      [
        'export interface CounterProps {',
        '  count?: number',
        '  disabled?: boolean',
        '}',
        'export declare const Counter: React.FC<CounterProps>',
      ].join('\n'),
    )
    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const counter = components.find((c) => c.name === 'Counter')
    expect(counter!.props.find((p) => p.name === 'count')?.kind).toEqual({ kind: 'number' })
    expect(counter!.props.find((p) => p.name === 'disabled')?.kind).toEqual({ kind: 'boolean' })
  })

  it('merges a forwardRef intersection props type (Props & RefAttributes<T>)', () => {
    installDts(
      'acme-ui',
      [
        'export interface InputProps {',
        '  placeholder?: string',
        '}',
        'export declare const Input: React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>>',
      ].join('\n'),
    )
    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const input = components.find((c) => c.name === 'Input')
    expect(input).toBeDefined()
    expect(input!.props.find((p) => p.name === 'placeholder')?.kind).toEqual({ kind: 'string' })
  })

  it('does not manifest a non-component generic-typed export', () => {
    installDts(
      'acme-ui',
      ["export declare const DEFAULT_LOCALES: Array<string>", 'export declare const Button: React.FC<{}>'].join('\n'),
    )
    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    expect(components.some((c) => c.name === 'DEFAULT_LOCALES')).toBe(false)
    expect(components.some((c) => c.name === 'Button')).toBe(true)
  })
})

describe('buildPackageManifest — .tsx source fallback (Tier 2, no .d.ts)', () => {
  it('extracts props from a raw .tsx source entry when no .d.ts is shipped', () => {
    write('node_modules/acme-raw/package.json', JSON.stringify({ name: 'acme-raw', version: '1.0.0', source: 'index.tsx' }))
    write(
      'node_modules/acme-raw/index.tsx',
      [
        "export function Chip(props: { label: string; tone?: 'neutral' | 'warning' }) {",
        '  return null',
        '}',
      ].join('\n'),
    )

    const { components } = buildPackageManifest(tmpDir, 'acme-raw')
    const chip = components.find((c) => c.name === 'Chip')
    expect(chip).toBeDefined()
    expect(chip!.props.find((p) => p.name === 'tone')?.kind).toEqual({ kind: 'enum', values: ['neutral', 'warning'] })
    expect(chip!.props.find((p) => p.name === 'label')?.kind).toEqual({ kind: 'string' })
  })
})

describe('buildPackageManifest — honest gaps and refusals', () => {
  it('warns and returns no components when the package is not installed', () => {
    const { components, warnings } = buildPackageManifest(tmpDir, 'not-installed')
    expect(components).toEqual([])
    expect(warnings.some((w) => w.code === 'package-manifest-static-empty')).toBe(true)
  })

  it('never resolves a package entry that escapes the workspace through a symlink, when the host permits creating one', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-manifest-outside-'))
    try {
      write('node_modules/evil-ui/package.json', JSON.stringify({ name: 'evil-ui', version: '1.0.0', types: 'index.d.ts' }))
      const maliciousDts = path.join(outsideDir, 'index.d.ts')
      fs.writeFileSync(maliciousDts, 'export declare const Button: React.FC<{}>\n', 'utf8')
      const linkPath = path.join(tmpDir, 'node_modules', 'evil-ui', 'index.d.ts')

      try {
        fs.symlinkSync(maliciousDts, linkPath, 'file')
      } catch {
        // Some hosts (notably Windows without Developer Mode / elevation)
        // refuse to create symlinks at all — nothing to test there.
        return
      }

      const { components, warnings } = buildPackageManifest(tmpDir, 'evil-ui')
      expect(components).toEqual([])
      expect(warnings.some((w) => w.code === 'package-manifest-static-empty')).toBe(true)
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('classifyPropType', () => {
  it('classifies an optional string union (T | undefined) exactly like a bare union', () => {
    // A prop's `?` question token, not an explicit `| undefined` in the type
    // text, is how TS marks optionality — but this must still be robust if a
    // package's .d.ts writes the union explicitly.
    installDts(
      'acme-ui',
      [
        'export interface ButtonProps {',
        "  variant: 'primary' | 'ghost' | undefined",
        '}',
        'export declare const Button: React.FC<ButtonProps>',
      ].join('\n'),
    )
    const { components } = buildPackageManifest(tmpDir, 'acme-ui')
    const button = components.find((c) => c.name === 'Button')
    expect(button!.props.find((p) => p.name === 'variant')?.kind).toEqual({ kind: 'enum', values: ['primary', 'ghost'] })
  })

  it('returns unknown for a type node it cannot resolve', () => {
    expect(classifyPropType('anything', undefined)).toEqual({ kind: 'unknown' })
  })
})
