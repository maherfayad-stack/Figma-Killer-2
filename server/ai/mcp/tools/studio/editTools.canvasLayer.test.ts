/**
 * FC-1 (P5-G) — the security review of #260, blocker B1: `studio_codemod`
 * decodes its node id itself, so before the decoder refused loose-layer
 * modules by DEFAULT it wrote straight into `.studio/canvas/<id>.tsx` — an
 * agent could rewrite a layer's import to any package, silently (no reload),
 * and the human's later drag into a frame carried it into a real page.
 *
 * Every verb must refuse a layer node id and leave the module's bytes exactly
 * as they were. The same verbs on an ordinary page still write (the control),
 * so a refusal here is the scope, not a broken tool.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { studioEditMcpTools } from './editTools'

const LAYER_REL = '.studio/canvas/cl0123456789.tsx'
const LAYER_SOURCE = [
  '// Studio free-canvas layer',
  "import { Card } from '../../components/Card'",
  'export default function Layer() {',
  '  return (',
  '    <Card title="Hi" />',
  '  )',
  '}',
  '',
].join('\n')
const CARD_SOURCE = [
  'export function Card({ title }: { title: string }) {',
  '  return <div className="card">{title}</div>',
  '}',
  '',
].join('\n')

function codemod() {
  const found = studioEditMcpTools.find((tool) => tool.name === 'studio_codemod')
  if (!found?.handler) throw new Error('studio_codemod not found')
  return found.handler
}

function write(root: string, rel: string, contents: string): void {
  const full = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('studio_codemod never writes a free-canvas layer module (FC-1, #260 B1)', () => {
  let dir: string
  let layerFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-codemod-layer-'))
    write(dir, 'components/Card.tsx', CARD_SOURCE)
    write(dir, 'components/Other.tsx', CARD_SOURCE.replace('function Card', 'function Other'))
    write(dir, LAYER_REL, LAYER_SOURCE)
    layerFile = path.join(dir, ...LAYER_REL.split('/'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cases: { verb: string; nodeId: string; extra: Record<string, string> }[] = [
    { verb: 'set-import-specifier', nodeId: `${LAYER_REL}:2:22`, extra: { specifier: 'evil-pkg' } },
    { verb: 'rename-tag', nodeId: `${LAYER_REL}:5:5`, extra: { tag: 'section' } },
    { verb: 'detach', nodeId: `${LAYER_REL}:5:5`, extra: {} },
    {
      verb: 'swap',
      nodeId: `${LAYER_REL}:5:5`,
      extra: { newComponentName: 'Other', newComponentSource: 'local', newComponentFile: 'components/Other.tsx' },
    },
    { verb: 'extract-component', nodeId: `${LAYER_REL}:5:5`, extra: {} },
  ]

  for (const { verb, nodeId, extra } of cases) {
    it(`${verb} refuses a layer node id and leaves the module byte-identical`, async () => {
      const result = (await codemod()({ dir, verb, nodeId, ...extra }, {} as never)) as { ok: boolean; code?: string }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('no-writable-location')
      expect(fs.readFileSync(layerFile, 'utf8')).toBe(LAYER_SOURCE)
    })
  }

  it('control: the same verb on an ordinary page still writes', async () => {
    write(dir, 'pages/Home.tsx', ["import { Card } from '../components/Card'", 'export default function Home() {', '  return <Card title="Hi" />', '}', ''].join('\n'))
    const result = (await codemod()(
      { dir, verb: 'set-import-specifier', nodeId: 'pages/Home.tsx:1:22', specifier: '../components/Other' },
      {} as never,
    )) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain("'../components/Other'")
  })
})
