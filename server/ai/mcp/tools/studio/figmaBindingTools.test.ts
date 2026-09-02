/**
 * studio_list_component_bindings — coverage. See `componentCatalogTools.test.ts`
 * for the folded-into-the-catalog behaviour; this file covers the standalone
 * deep-dive tool: the full per-value mapping, the `fileKeys` rollup (the
 * question that mattered enough to justify a separate tool — does a
 * project's design system point at one Figma file or several), filtering,
 * and honest truncation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioFigmaBindingMcpTools } from './figmaBindingTools'

const tool = studioFigmaBindingMcpTools[0]!

let dir: string

function write(relPath: string, contents: string): void {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function writeRootPackageJson(deps: Record<string, string>): void {
  write('package.json', JSON.stringify({ name: 'fixture-app', dependencies: deps }))
}

/** A component package discoverable via the Tier-2 built-JS heuristic (no `.d.ts` at all) — see `componentCatalogTools.test.ts`'s identical fixture for why this shape is required for `ProjectProfile.componentPackages` to include it. */
function installUntypedComponentPackage(pkgName: string): void {
  write(`node_modules/${pkgName}/package.json`, JSON.stringify({ name: pkgName, version: '1.0.0', main: 'dist/index.js' }))
  write(`node_modules/${pkgName}/dist/index.js`, "import { jsx } from 'react/jsx-runtime'\nexport function Button(props) { return jsx('button', props) }\n")
}

function installFigmaConnect(pkgName: string, componentFile: string, contents: string): void {
  write(`node_modules/${pkgName}/src/components/${componentFile}.figma.tsx`, contents)
}

function connectSource(component: string, fileKey: string, nodeId: string): string {
  return [
    "import figma from '@figma/code-connect'",
    `import { ${component} } from './${component}'`,
    `figma.connect(${component}, 'https://www.figma.com/design/${fileKey}/Styles?node-id=${nodeId}', {`,
    '  props: {',
    `    variant: figma.enum('Type', { Primary: 'primary', Secondary: 'secondary' }),`,
    '  },',
    `  example: ({ variant }) => <${component} variant={variant} />,`,
    '})',
    '',
  ].join('\n')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-figma-binding-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function call(input: Record<string, unknown> = {}) {
  return tool.handler!({ dir, ...input }, {} as never)
}

describe('studio_list_component_bindings', () => {
  it('returns an empty bindings list — not an error — for a project with no Code Connect files', async () => {
    const result = (await call()) as { ok: boolean; bindings: unknown[]; fileKeys: string[] }
    expect(result.ok).toBe(true)
    expect(result.bindings).toEqual([])
    expect(result.fileKeys).toEqual([])
  })

  it('lists a binding with its full per-value mapping and example', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installUntypedComponentPackage('acme-ui')
    installFigmaConnect('acme-ui', 'Button', connectSource('Button', 'FILEKEY1', '1-2'))

    const result = (await call()) as {
      bindings: Array<{
        pkg: string
        component: string
        figmaFileKey?: string
        figmaNodeId?: string
        props: Array<{ name: string; figmaProperty: string; mapping?: Array<{ figmaValue: string; codeValue: unknown }> }>
        example?: string
      }>
    }

    expect(result.bindings).toHaveLength(1)
    const binding = result.bindings[0]!
    expect(binding.pkg).toBe('acme-ui')
    expect(binding.component).toBe('Button')
    expect(binding.figmaFileKey).toBe('FILEKEY1')
    expect(binding.figmaNodeId).toBe('1:2')
    expect(binding.props[0]!.figmaProperty).toBe('Type')
    expect(binding.props[0]!.mapping).toEqual([
      { figmaValue: 'Primary', codeValue: 'primary' },
      { figmaValue: 'Secondary', codeValue: 'secondary' },
    ])
    expect(binding.example).toContain('<Button variant={variant} />')
  })

  it('reports every DISTINCT Figma file key referenced across bindings — the question that justifies this tool', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installUntypedComponentPackage('acme-ui')
    installFigmaConnect('acme-ui', 'Button', connectSource('Button', 'FILEKEY1', '1-2'))
    installFigmaConnect('acme-ui', 'Checkbox', connectSource('Checkbox', 'FILEKEY2', '3-4'))

    const result = (await call()) as { fileKeys: string[]; bindings: unknown[] }
    expect(result.bindings).toHaveLength(2)
    expect(result.fileKeys).toEqual(['FILEKEY1', 'FILEKEY2'])
  })

  it('filters by component name and package', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0', 'other-ui': '^1.0.0' })
    installUntypedComponentPackage('acme-ui')
    installUntypedComponentPackage('other-ui')
    installFigmaConnect('acme-ui', 'Button', connectSource('Button', 'FILEKEY1', '1-2'))
    installFigmaConnect('other-ui', 'Badge', connectSource('Badge', 'FILEKEY2', '3-4'))

    const byName = (await call({ filter: 'butt' })) as { bindings: Array<{ component: string }> }
    expect(byName.bindings.map((b) => b.component)).toEqual(['Button'])

    const byPackage = (await call({ package: 'other-ui' })) as { bindings: Array<{ component: string }> }
    expect(byPackage.bindings.map((b) => b.component)).toEqual(['Badge'])
  })

  it('caps the response and reports the omitted count honestly', async () => {
    writeRootPackageJson({ 'acme-ui': '^1.0.0' })
    installUntypedComponentPackage('acme-ui')
    for (const name of ['CompA', 'CompB', 'CompC']) {
      installFigmaConnect('acme-ui', name, connectSource(name, 'FILEKEY1', '1-2'))
    }

    const result = (await call({ limit: 1 })) as {
      bindings: unknown[]
      truncated: boolean
      omittedCount: number
      matchedBindings: number
    }
    expect(result.bindings).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.omittedCount).toBe(2)
    expect(result.matchedBindings).toBe(3)
  })
})
