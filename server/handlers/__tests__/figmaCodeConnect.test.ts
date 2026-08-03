/**
 * figmaCodeConnect — coverage for the static Figma Code Connect (*.figma.tsx)
 * extraction. Fixtures are tiny, hand-written mapping files written directly
 * into a fixture's own `node_modules/` (same discipline as
 * `packageManifest.test.ts`), covering every shape confirmed against the
 * real 29-file `@alm-design/design-system` corpus: a REPLACE-ME placeholder
 * node-id, a boolean-valued enum mapping, a literal empty `props: {}`, an
 * inline "(approx)" caveat comment, an import whose local name differs from
 * the file's own basename, and an unparseable file that must degrade rather
 * than fail the whole batch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  collectFigmaCodeConnectComponents,
  listFigmaConnectFiles,
  parseFigmaConnectUrl,
} from '../studio/figmaCodeConnect'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-code-connect-'))
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

function installFigmaConnect(pkgName: string, componentFile: string, contents: string): void {
  write(`node_modules/${pkgName}/src/components/${componentFile}.figma.tsx`, contents)
}

describe('parseFigmaConnectUrl', () => {
  it('parses the file key and normalizes a real node-id to colon form', () => {
    const parsed = parseFigmaConnectUrl('https://www.figma.com/design/8nasqgUrdKsT8JgQRBHwPB/Styles?node-id=53958-5861')
    expect(parsed).toEqual({ figmaFileKey: '8nasqgUrdKsT8JgQRBHwPB', figmaNodeId: '53958:5861', nodeIdPlaceholder: false })
  })

  it('flags a REPLACE-ME node-id as a placeholder, not a resolvable reference', () => {
    const parsed = parseFigmaConnectUrl('https://www.figma.com/design/ABC123/Styles?node-id=REPLACE-ME')
    expect(parsed.figmaFileKey).toBe('ABC123')
    expect(parsed.figmaNodeId).toBe('REPLACE-ME')
    expect(parsed.nodeIdPlaceholder).toBe(true)
  })

  it('degrades to undefined fields for a URL with no node-id param at all', () => {
    const parsed = parseFigmaConnectUrl('https://www.figma.com/design/ABC123/Styles')
    expect(parsed.figmaFileKey).toBe('ABC123')
    expect(parsed.figmaNodeId).toBeUndefined()
    expect(parsed.nodeIdPlaceholder).toBe(true)
  })

  it('never throws on a URL matching nothing at all', () => {
    const parsed = parseFigmaConnectUrl('not a url')
    expect(parsed).toEqual({ figmaFileKey: undefined, figmaNodeId: undefined, nodeIdPlaceholder: true })
  })
})

describe('listFigmaConnectFiles', () => {
  it('finds every *.figma.tsx file under a package, sorted, ignoring plain component files', () => {
    write('node_modules/acme-ui/src/components/Button.tsx', 'export const Button = () => null')
    write('node_modules/acme-ui/src/components/Button.figma.tsx', '// not real code connect syntax')
    write('node_modules/acme-ui/src/components/Badge.figma.tsx', '// not real code connect syntax')

    const files = listFigmaConnectFiles(path.join(tmpDir, 'node_modules', 'acme-ui'))
    expect(files).toEqual(['src/components/Badge.figma.tsx', 'src/components/Button.figma.tsx'])
  })

  it('returns an empty list for a package with none — the ordinary case', () => {
    write('node_modules/acme-ui/package.json', '{}')
    const files = listFigmaConnectFiles(path.join(tmpDir, 'node_modules', 'acme-ui'))
    expect(files).toEqual([])
  })
})

describe('collectFigmaCodeConnectComponents', () => {
  it('extracts a full enum + string mapping, with per-prop leading and per-value inline notes', () => {
    installFigmaConnect(
      'acme-ui',
      'Button',
      [
        '// Code Connect mapping for Button — verified against Figma node 1:2.',
        "import figma from '@figma/code-connect'",
        "import { Button } from './Button'",
        '',
        "figma.connect(Button, 'https://www.figma.com/design/FILEKEY/Styles?node-id=1-2', {",
        '  props: {',
        '    // Figma Type -> code variant.',
        "    variant: figma.enum('Type', {",
        "      Primary: 'primary',",
        "      Disabled: 'primary', // (approx) modeled as a Type in Figma, an attr in code",
        '    }),',
        "    label: figma.string('Label'),",
        '  },',
        '  example: ({ variant, label }) => (',
        '    <Button variant={variant} label={label} />',
        '  ),',
        '})',
        '',
      ].join('\n'),
    )

    const { components, warnings } = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')

    expect(warnings).toEqual([])
    expect(components).toHaveLength(1)
    const button = components[0]!
    expect(button.component).toBe('Button')
    expect(button.file).toBe('src/components/Button.figma.tsx')
    expect(button.figmaFileKey).toBe('FILEKEY')
    expect(button.figmaNodeId).toBe('1:2')
    expect(button.nodeIdPlaceholder).toBe(false)
    expect(button.verifiedNote).toContain('verified against Figma node 1:2')

    const variant = button.props.find((p) => p.name === 'variant')!
    expect(variant.figmaProperty).toBe('Type')
    expect(variant.kind).toBe('enum')
    expect(variant.note).toBe('Figma Type -> code variant.')
    expect(variant.mapping).toEqual([
      { figmaValue: 'Primary', codeValue: 'primary' },
      { figmaValue: 'Disabled', codeValue: 'primary', note: '(approx) modeled as a Type in Figma, an attr in code' },
    ])

    const label = button.props.find((p) => p.name === 'label')!
    expect(label.kind).toBe('string')
    expect(label.figmaProperty).toBe('Label')

    expect(button.example).toContain('<Button variant={variant} label={label} />')
  })

  it('extracts a boolean-valued enum mapping (figma.enum with true/false code values)', () => {
    installFigmaConnect(
      'acme-ui',
      'Checkbox',
      [
        "import figma from '@figma/code-connect'",
        "import { Checkbox } from './Checkbox'",
        "figma.connect(Checkbox, 'https://www.figma.com/design/FILEKEY/Styles?node-id=3-4', {",
        '  props: {',
        "    checked: figma.enum('Selected', { True: true, False: false }),",
        '  },',
        '  example: ({ checked }) => <Checkbox checked={checked} />,',
        '})',
        '',
      ].join('\n'),
    )

    const { components } = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')
    const checked = components[0]!.props[0]!
    expect(checked.kind).toBe('enum')
    expect(checked.mapping).toEqual([
      { figmaValue: 'True', codeValue: true },
      { figmaValue: 'False', codeValue: false },
    ])
  })

  it('handles a literal empty props: {} without error', () => {
    installFigmaConnect(
      'acme-ui',
      'Stepper',
      [
        "import figma from '@figma/code-connect'",
        "import { Stepper } from './Stepper'",
        "figma.connect(Stepper, 'https://www.figma.com/design/FILEKEY/Styles?node-id=5-6', {",
        '  props: {},',
        '  example: () => <Stepper value={1} />,',
        '})',
        '',
      ].join('\n'),
    )

    const { components } = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')
    expect(components).toHaveLength(1)
    expect(components[0]!.props).toEqual([])
  })

  it('extracts the component identity from figma.connect\'s own first argument, not the file basename', () => {
    // Mirrors the real corpus: `ListItem.figma.tsx` imports `{ ListItem } from './List'`.
    installFigmaConnect(
      'acme-ui',
      'ListItem',
      [
        "import figma from '@figma/code-connect'",
        "import { ListItem } from './List'",
        "figma.connect(ListItem, 'https://www.figma.com/design/FILEKEY/Styles?node-id=7-8', {",
        '  props: {},',
        '  example: () => <ListItem />,',
        '})',
        '',
      ].join('\n'),
    )

    const { components } = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')
    expect(components[0]!.component).toBe('ListItem')
  })

  it('returns { components: [], warnings: [] } — not an error — for a package with no Code Connect files at all', () => {
    write('node_modules/acme-ui/package.json', '{}')
    const result = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')
    expect(result).toEqual({ components: [], warnings: [] })
  })

  it('returns { components: [], warnings: [] } for a package directory that does not exist at all', () => {
    const result = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'nonexistent'), 'nonexistent')
    expect(result).toEqual({ components: [], warnings: [] })
  })

  it('degrades a single unparseable *.figma.tsx file to a warning instead of failing the batch', () => {
    installFigmaConnect('acme-ui', 'Broken', 'this is not valid code connect syntax at all, no figma.connect call\n')
    installFigmaConnect(
      'acme-ui',
      'Button',
      [
        "import figma from '@figma/code-connect'",
        "import { Button } from './Button'",
        "figma.connect(Button, 'https://www.figma.com/design/FILEKEY/Styles?node-id=1-2', {",
        '  props: {},',
        '  example: () => <Button />,',
        '})',
        '',
      ].join('\n'),
    )

    const { components, warnings } = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')
    expect(components).toHaveLength(1)
    expect(components[0]!.component).toBe('Button')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.code).toBe('figma-connect-unparseable')
    expect(warnings[0]!.message).toContain('Broken.figma.tsx')
  })

  it('drops a mapping value this extractor cannot evaluate as a literal, rather than guessing', () => {
    installFigmaConnect(
      'acme-ui',
      'Weird',
      [
        "import figma from '@figma/code-connect'",
        "import { Weird } from './Weird'",
        "const dynamicValue = computeSomething()",
        "figma.connect(Weird, 'https://www.figma.com/design/FILEKEY/Styles?node-id=1-2', {",
        '  props: {',
        "    variant: figma.enum('Type', { Known: 'known', Unknown: dynamicValue }),",
        '  },',
        '  example: () => <Weird />,',
        '})',
        '',
      ].join('\n'),
    )

    const { components } = collectFigmaCodeConnectComponents(path.join(tmpDir, 'node_modules', 'acme-ui'), 'acme-ui')
    expect(components[0]!.props[0]!.mapping).toEqual([{ figmaValue: 'Known', codeValue: 'known' }])
  })
})
