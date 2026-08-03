/**
 * studio_list_components / studio_find_component — coverage for the
 * design-system component catalog tools. Fixtures are tiny, hand-written
 * `node_modules/<pkg>` packages (same discipline as
 * `packageManifest.test.ts`) plus a root `package.json` naming the
 * dependency, since `buildPackageManifest` is only ever reached through this
 * tool's own `ProjectProfile.componentPackages` demand list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioComponentCatalogMcpTools } from './componentCatalogTools'

function tool(name: string) {
  const t = studioComponentCatalogMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

let dir: string

function write(relPath: string, contents: string): void {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function writeRootPackageJson(deps: Record<string, string>): void {
  write('package.json', JSON.stringify({ name: 'fixture-app', dependencies: deps }))
}

function installDts(pkgName: string, dtsContents: string): void {
  write(`node_modules/${pkgName}/package.json`, JSON.stringify({ name: pkgName, version: '1.0.0', types: 'index.d.ts' }))
  write(`node_modules/${pkgName}/index.d.ts`, dtsContents)
}

function installFigmaConnectFile(pkgName: string, componentName: string, contents: string): void {
  write(`node_modules/${pkgName}/src/components/${componentName}.figma.tsx`, contents)
}

/**
 * A component package with NO `.d.ts` and NO typed `.tsx`/`.jsx` source entry
 * — `buildPackageManifest` returns zero components for it (matching the real
 * `@alm-design/design-system`, which ships only a bundled `dist/index.js`) —
 * but its built JS entry still satisfies `isComponentPackage`'s Tier-2
 * heuristic (imports the JSX runtime + exports a PascalCase binding), so it
 * DOES land in `ProjectProfile.componentPackages` and this tool's
 * Code-Connect collection pass actually reaches it.
 */
function installUntypedComponentPackage(pkgName: string): void {
  write(`node_modules/${pkgName}/package.json`, JSON.stringify({ name: pkgName, version: '1.0.0', main: 'dist/index.js' }))
  write(`node_modules/${pkgName}/dist/index.js`, "import { jsx } from 'react/jsx-runtime'\nexport function Button(props) { return jsx('button', props) }\n")
}

function buttonFigmaConnectSource(): string {
  return [
    "import figma from '@figma/code-connect'",
    "import { Button } from './Button'",
    '',
    "figma.connect(Button, 'https://www.figma.com/design/FILEKEY123/Styles?node-id=1-2', {",
    '  props: {',
    "    variant: figma.enum('Type', { Primary: 'primary', Secondary: 'secondary' }),",
    "    disabled: figma.boolean('Disabled'),",
    '  },',
    "  example: ({ variant }) => <Button variant={variant} />,",
    '})',
    '',
  ].join('\n')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-component-catalog-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function call(name: string, input: Record<string, unknown> = {}) {
  return tool(name).handler!({ dir, ...input }, {} as never)
}

describe('studio_list_components', () => {
  it('lists a component with its props and the package to import from', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts(
      'acme-ui',
      [
        'export interface ButtonProps {',
        "  variant?: 'primary' | 'ghost'",
        '  label: string',
        '}',
        'export declare const Button: React.FC<ButtonProps>',
      ].join('\n'),
    )

    const result = (await call('studio_list_components')) as {
      ok: boolean
      components: Array<{ name: string; pkg: string; props: Array<{ name: string; kind: unknown; required: boolean }> }>
    }

    expect(result.ok).toBe(true)
    expect(result.components).toHaveLength(1)
    const button = result.components[0]!
    expect(button.name).toBe('Button')
    expect(button.pkg).toBe('acme-ui')
    expect(button.props.find((p) => p.name === 'variant')?.kind).toEqual({ kind: 'enum', values: ['primary', 'ghost'] })
    expect(button.props.find((p) => p.name === 'label')?.required).toBe(true)
  })

  it('marks an overlay/portal component name as hidden from the palette', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts('acme-ui', ['export declare const Dialog: React.FC<{ title: string }>'].join('\n'))

    const result = (await call('studio_list_components')) as { components: Array<{ name: string; hiddenFromPalette: boolean }> }
    expect(result.components[0]!.hiddenFromPalette).toBe(true)
  })

  it('honours an explicit .studio/meta.json paletteHiddenModuleIds override', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts('acme-ui', ['export declare const Drawer: React.FC<{ title: string }>'].join('\n'))
    write('.studio/meta.json', JSON.stringify({ paletteHiddenModuleIds: ['pkg.acme_ui.Drawer'] }))

    const result = (await call('studio_list_components')) as { components: Array<{ name: string; hiddenFromPalette: boolean }> }
    expect(result.components[0]!.hiddenFromPalette).toBe(true)
  })

  it('does not hide an ordinary component name', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts('acme-ui', ['export declare const Badge: React.FC<{ label: string }>'].join('\n'))

    const result = (await call('studio_list_components')) as { components: Array<{ name: string; hiddenFromPalette: boolean }> }
    expect(result.components[0]!.hiddenFromPalette).toBe(false)
  })

  it('filters by name, case-insensitively', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts(
      'acme-ui',
      ['export declare const Button: React.FC<{ label: string }>', 'export declare const Badge: React.FC<{ label: string }>'].join('\n'),
    )

    const result = (await call('studio_list_components', { filter: 'BAD' })) as {
      components: Array<{ name: string }>
      totalComponents: number
      matchedComponents: number
    }
    expect(result.components.map((c) => c.name)).toEqual(['Badge'])
    expect(result.totalComponents).toBe(2)
    expect(result.matchedComponents).toBe(1)
  })

  it('restricts to one package with the package filter', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0', 'other-ui': '^1.0.0' })
    installDts('acme-ui', ['export declare const Button: React.FC<{ label: string }>'].join('\n'))
    installDts('other-ui', ['export declare const Chip: React.FC<{ label: string }>'].join('\n'))

    const result = (await call('studio_list_components', { package: 'other-ui' })) as { components: Array<{ name: string; pkg: string }> }
    expect(result.components).toEqual([{
      name: 'Chip',
      pkg: 'other-ui',
      file: 'index.d.ts',
      exportName: 'Chip',
      isDefaultExport: false,
      hiddenFromPalette: false,
      apiSource: 'types',
      props: [{ name: 'label', kind: { kind: 'string' }, required: true }],
    }])
  })

  it('caps the response and reports the omitted count honestly', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    const decls = Array.from({ length: 5 }, (_, i) => `export declare const Comp${i}: React.FC<{ label: string }>`).join('\n')
    installDts('acme-ui', decls)

    const result = (await call('studio_list_components', { limit: 2 })) as {
      components: unknown[]
      truncated: boolean
      omittedCount: number
      matchedComponents: number
    }
    expect(result.components).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.omittedCount).toBe(3)
    expect(result.matchedComponents).toBe(5)
  })

  it('reports a CSS-only imported design system by name, but extracts zero components from it', async () => {
    write('styles/imported/acme-ds-1-0-0/src/components/Button.css', '.btn {}')

    const result = (await call('studio_list_components')) as {
      ok: boolean
      components: unknown[]
      packages: string[]
      designSystems: Array<{ name: string; source: string; root: string }>
      note?: string
    }

    expect(result.ok).toBe(true)
    expect(result.packages).toEqual([])
    expect(result.components).toEqual([])
    expect(result.designSystems).toEqual([
      { name: 'acme-ds-1-0-0', source: 'imported', root: 'styles/imported/acme-ds-1-0-0' },
    ])
    expect(result.note).toBeDefined()
    expect(result.note).toContain('acme-ds-1-0-0')
  })

  it('reports no note at all for a project with neither an installed nor an imported design system', async () => {
    const result = (await call('studio_list_components')) as { components: unknown[]; designSystems: unknown[]; note?: string }
    expect(result.components).toEqual([])
    expect(result.designSystems).toEqual([])
    expect(result.note).toBeUndefined()
  })

  describe('Figma Code Connect folding', () => {
    it('synthesizes an apiSource:"code-connect" entry for a component with no typed API at all', async () => {
      writeRootPackageJson({ 'acme-ui': '^1.0.0' })
      installUntypedComponentPackage('acme-ui')
      installFigmaConnectFile('acme-ui', 'Button', buttonFigmaConnectSource())

      const result = (await call('studio_list_components')) as {
        components: Array<{
          name: string
          apiSource: string
          props: Array<{ name: string; kind: unknown; required: boolean }>
          figma?: { url: string; fileKey?: string; nodeId?: string; nodeIdPlaceholder: boolean }
        }>
      }

      expect(result.components).toHaveLength(1)
      const button = result.components[0]!
      expect(button.name).toBe('Button')
      expect(button.apiSource).toBe('code-connect')
      // `variant` reduces to a real PropKind.enum from the Figma mapping's code-side values.
      expect(button.props.find((p) => p.name === 'variant')?.kind).toEqual({ kind: 'enum', values: ['primary', 'secondary'] })
      expect(button.props.find((p) => p.name === 'disabled')?.kind).toEqual({ kind: 'boolean' })
      // Code Connect has no "required" signal — never guessed as true.
      expect(button.props.every((p) => p.required === false)).toBe(true)
      expect(button.figma?.url).toBe('https://www.figma.com/design/FILEKEY123/Styles?node-id=1-2')
      expect(button.figma?.fileKey).toBe('FILEKEY123')
      expect(button.figma?.nodeId).toBe('1:2')
      expect(button.figma?.nodeIdPlaceholder).toBe(false)
    })

    it('attaches a figma summary to a types-derived entry instead of duplicating it, when both sources name the same component', async () => {
      writeRootPackageJson({ 'acme-ui': '^1.0.0' })
      installDts('acme-ui', ["export interface ButtonProps { label: string }", 'export declare const Button: React.FC<ButtonProps>'].join('\n'))
      installFigmaConnectFile('acme-ui', 'Button', buttonFigmaConnectSource())

      const result = (await call('studio_list_components')) as {
        components: Array<{ name: string; apiSource: string; props: unknown[]; figma?: { fileKey?: string } }>
      }

      expect(result.components).toHaveLength(1)
      const button = result.components[0]!
      // The MORE PRECISE source wins for `apiSource`/`props` — the .d.ts shape, not the Figma-reduced one.
      expect(button.apiSource).toBe('types')
      expect(button.props).toEqual([{ name: 'label', kind: { kind: 'string' }, required: true }])
      // But the Figma binding is still surfaced, as its own field.
      expect(button.figma?.fileKey).toBe('FILEKEY123')
    })

    it('flags a REPLACE-ME node-id as a placeholder rather than a resolvable reference', async () => {
      writeRootPackageJson({ 'acme-ui': '^1.0.0' })
      installUntypedComponentPackage('acme-ui')
      installFigmaConnectFile(
        'acme-ui',
        'Button',
        [
          "import figma from '@figma/code-connect'",
          "import { Button } from './Button'",
          "figma.connect(Button, 'https://www.figma.com/design/FILEKEY123/Styles?node-id=REPLACE-ME', {",
          "  props: {},",
          '  example: () => <Button />,',
          '})',
          '',
        ].join('\n'),
      )

      const result = (await call('studio_list_components')) as { components: Array<{ figma?: { nodeIdPlaceholder: boolean } }> }
      expect(result.components[0]!.figma?.nodeIdPlaceholder).toBe(true)
    })
  })
})

describe('studio_find_component', () => {
  it('requires at least one of name/prop', async () => {
    const result = (await call('studio_find_component')) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('matches components by a prop name they declare', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts(
      'acme-ui',
      [
        "export declare const Button: React.FC<{ variant?: 'a' | 'b' }>",
        'export declare const Badge: React.FC<{ label: string }>',
      ].join('\n'),
    )

    const result = (await call('studio_find_component', { prop: 'variant' })) as { components: Array<{ name: string }> }
    expect(result.components.map((c) => c.name)).toEqual(['Button'])
  })

  it('matches components by name, case-insensitively', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts(
      'acme-ui',
      ['export declare const Button: React.FC<{ label: string }>', 'export declare const Badge: React.FC<{ label: string }>'].join('\n'),
    )

    const result = (await call('studio_find_component', { name: 'butt' })) as { components: Array<{ name: string }> }
    expect(result.components.map((c) => c.name)).toEqual(['Button'])
  })

  it('combines name and prop filters', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installDts(
      'acme-ui',
      [
        "export declare const Button: React.FC<{ variant?: 'a' | 'b' }>",
        "export declare const Badge: React.FC<{ variant?: 'a' | 'b' }>",
      ].join('\n'),
    )

    const result = (await call('studio_find_component', { name: 'badge', prop: 'variant' })) as { components: Array<{ name: string }> }
    expect(result.components.map((c) => c.name)).toEqual(['Badge'])
  })
})
