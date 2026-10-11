/**
 * designSystemMaterialize - the first design-system insert into a project that
 * does not carry the design system brings the folder and the meta field in the
 * SAME journaled batch, and the batch's one undo takes all of it back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let dir: string
const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}
const meta = (): { designSystem?: string } => (fs.existsSync(abs('.studio/meta.json')) ? JSON.parse(read('.studio/meta.json')) : {})

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const PAGE = `export default function Home() {
  return (
    <section className="wrap">
      <p>hi</p>
    </section>
  )
}
`
const insertTabBar: StudioEdit = {
  kind: 'insert',
  nodeId: 'pages/Home.tsx:3:6',
  name: 'TabBar',
  designSystemImport: true,
  props: { value: 0 },
}
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-materialize-')))
  write('pages/Home.tsx', PAGE)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the first design-system insert into a project without the design system', () => {
  it('writes the folder and the meta with the page, and one restore removes all of it', () => {
    const forward = applyStudioEditBatch(dir, [insertTabBar], {}, EDITOR)
    expect(forward.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toContain("import { TabBar } from '../design-system'")
    expect(fs.existsSync(abs('design-system/index.js'))).toBe(true)
    expect(meta().designSystem).toBe('alm')
    expect(forward.undoToken).toMatch(/^[0-9a-f]{32}$/)

    // The preview shell Studio generates imports the folder too; that is not a user of it.
    write('prototype/providers.generated.jsx', `import { DesignSystemProvider } from '../design-system'
export const x = DesignSystemProvider
`)

    const back = applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toBe(PAGE)
    expect(fs.existsSync(abs('design-system'))).toBe(false)
    expect(fs.existsSync(abs('.studio/design-system.json'))).toBe(false)
    expect(meta().designSystem).toBeUndefined()
  })

  it('leaves a project that already carries the folder exactly as it was', () => {
    write('design-system/index.js', 'export function TabBar() { return null }\n')
    const forward = applyStudioEditBatch(dir, [insertTabBar], {}, EDITOR)
    expect(forward.refusals).toEqual([])
    expect(read('design-system/index.js')).toBe('export function TabBar() { return null }\n')
    expect(meta().designSystem).toBeUndefined()
  })

  it('keeps the folder on undo while another file still imports it', () => {
    const forward = applyStudioEditBatch(dir, [insertTabBar], {}, EDITOR)
    write('pages/About.tsx', "import { Chip } from '../design-system'\nexport default function About() { return <Chip /> }\n")
    applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(read('pages/Home.tsx')).toBe(PAGE)
    expect(fs.existsSync(abs('design-system/index.js'))).toBe(true)
  })

  it('leaves nothing behind when the insert is refused', () => {
    const refused = applyStudioEditBatch(dir, [{ ...insertTabBar, nodeId: 'pages/Home.tsx:99:1' }], {}, EDITOR)
    expect(refused.written).toBe(0)
    expect(fs.existsSync(abs('design-system'))).toBe(false)
    expect(meta().designSystem).toBeUndefined()
  })
})
