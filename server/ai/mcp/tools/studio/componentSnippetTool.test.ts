/**
 * `studio_component_snippet` (AI-14): the import is right for the file it is
 * going into, and a prop value the component does not accept is refused with
 * the values it does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioComponentSnippetMcpTools } from './componentSnippetTool'

const tool = studioComponentSnippetMcpTools[0]!

let dir: string

function write(relPath: string, contents: string): void {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

type Result = Record<string, unknown> & { ok: boolean; code?: string; message?: string; remedy?: string }

async function call(input: Record<string, unknown>): Promise<Result> {
  return (await tool.handler!({ dir, ...input } as never, {} as never)) as Result
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-component-snippet-'))
  write('package.json', JSON.stringify({ name: 'fixture-app', dependencies: { '@acme/ui': '1.0.0' } }))
  write('node_modules/@acme/ui/package.json', JSON.stringify({ name: '@acme/ui', version: '1.0.0', types: 'index.d.ts' }))
  write(
    'node_modules/@acme/ui/index.d.ts',
    [
      "export interface ChipProps { tone: 'neutral' | 'brand'; selected?: boolean; count?: number; label: string }",
      'export declare function Chip(props: ChipProps): JSX.Element',
      'export default function Card(props: { elevated?: boolean }): JSX.Element',
      '',
    ].join('\n'),
  )
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('studio_component_snippet — Studio\'s built-in design system', () => {
  beforeEach(() => write('design-system/index.js', 'export {}\n'))

  it('computes the import relative to the file it goes into', async () => {
    const top = await call({ name: 'Button', forFile: 'pages/Checkout.tsx', props: { variant: 'primary', size: 'medium' }, children: 'Continue' })
    expect(top.ok).toBe(true)
    expect(top.import).toBe("import { Button } from '../design-system'")
    expect(top.jsx).toBe('<Button variant="primary" size="medium">Continue</Button>')
    const nested = await call({ name: 'Button', forFile: 'src/screens/checkout/Pay.tsx' })
    expect(nested.import).toBe("import { Button } from '../../../design-system'")
  })

  it('refuses a size the component does not have, listing the ones it does', async () => {
    const result = await call({ name: 'Button', forFile: 'pages/Checkout.tsx', props: { size: 'large' } })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-prop-value')
    expect(String(result.remedy)).toContain('"default" | "medium" | "small"')
  })

  it('says whether the file already imports it', async () => {
    write('pages/Checkout.tsx', "import { Button, Card } from '../design-system'\nexport default function Checkout() { return null }\n")
    const result = await call({ name: 'Button', forFile: 'pages/Checkout.tsx' })
    expect(result.alreadyImported).toBe(true)
  })
})

describe('studio_component_snippet — a typed package', () => {
  it('writes a named import from the package, and lists the required props it could not fill', async () => {
    const result = await call({ name: 'Chip', forFile: 'src/App.tsx', props: { tone: 'brand', selected: true, count: 3 } })
    expect(result.ok).toBe(true)
    expect(result.import).toBe("import { Chip } from '@acme/ui'")
    expect(result.jsx).toBe('<Chip tone="brand" selected count={3} />')
    expect(result.complete).toBe(false)
    expect(result.unfilledRequired).toEqual([{ name: 'label', kind: 'string', literal: true }])
  })

  it('writes a default import for a default export', async () => {
    const result = await call({ name: 'Card', forFile: 'src/App.tsx', props: { elevated: false } })
    expect(result.import).toBe("import Card from '@acme/ui'")
    expect(result.jsx).toBe('<Card elevated={false} />')
  })

  it('refuses a prop the component does not declare, and a wrongly typed value', async () => {
    const undeclared = await call({ name: 'Chip', forFile: 'src/App.tsx', props: { colour: 'red' } })
    expect(undeclared.code).toBe('invalid-prop-value')
    const wrongType = await call({ name: 'Chip', forFile: 'src/App.tsx', props: { selected: 'yes' } })
    expect(wrongType.code).toBe('invalid-prop-value')
  })

  it('refuses an unknown component with the nearest names, and a path outside the project', async () => {
    const unknown = await call({ name: 'Chips', forFile: 'src/App.tsx' })
    expect(unknown.code).toBe('no-such-component')
    expect((unknown.nearest as string[])[0]).toBe('Chip')
    const outside = await call({ name: 'Chip', forFile: '../elsewhere/App.tsx' })
    expect(outside.code).toBe('path-outside-project')
  })
})
