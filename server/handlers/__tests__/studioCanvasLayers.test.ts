/**
 * P5-G — the free canvas, server side (FC-1, FC-2): loose layers load
 * outside the pages, their five edit kinds write exactly the bytes they say, and an
 * agent's batch never touches them.
 *
 * Every write test asserts the FILES — the honest oracle — not just the
 * counters: a place that reported success and left the module on disk, or a
 * lift that wrote the module and left the element in the page, is the bug.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch, StudioEditSchema, type StudioEdit } from '../studioWriteback'
import { tryServeStudioReloadScope } from '../studio/reloadScope'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'
import { agentWriteRefusal } from '../studio/agentWriteScope'

const HOME = `import { Badge } from '../components/Badge'

export default function Home() {
  return (
    <main className="home">
      <h1>Home</h1>
      <Badge tone="quiet">New</Badge>
    </main>
  )
}
`

const BADGE = `export function Badge({ tone, children }: { tone: string; children?: unknown }) {
  return <span className={tone}>{children as string}</span>
}
`

const LAYER_ID = 'cl0123456789'
const LAYER_REL = `.studio/canvas/${LAYER_ID}.tsx`

let wsDir: string

function write(rel: string, contents: string): void {
  const full = path.join(wsDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}
const read = (rel: string): string => fs.readFileSync(path.join(wsDir, ...rel.split('/')), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(wsDir, ...rel.split('/')))
const allow = { canvasLayers: 'allow' as const }

function id(rel: string, source: string, tag: string): string {
  const { line, col } = locateTag(source, tag)
  return `${rel}:${line}:${col}`
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  wsDir = fs.mkdtempSync(path.join(root, '__canvas_layers_test_'))
  write('pages/Home.tsx', HOME)
  write('components/Badge.tsx', BADGE)
})

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true })
  clearPageParseCache()
  clearStudioLoadMemo()
})

const IMAGE_LAYER = `/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.

export default function CanvasLayer() {
  return (
    <img src="/cat.png" alt="cat" width={64} height={48} />
  )
}
`

describe('canvas-layer-create', () => {
  it('writes the module, reports its root, and never touches a page', () => {
    const result = applyStudioEditBatch(
      wsDir,
      [
        {
          kind: 'canvas-layer-create',
          nodeId: `canvas-layer:${LAYER_ID}`,
          layerId: LAYER_ID,
          element: { name: 'img', props: { src: '/cat.png', alt: 'cat', width: 64, height: 48 } },
        },
      ],
      {},
      allow,
    )
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read(LAYER_REL)).toBe(IMAGE_LAYER)
    expect(read('pages/Home.tsx')).toBe(HOME)
    expect(result.createdNodeIds).toEqual([`${LAYER_REL}:6:6`])
    expect(result.touchedFiles.some((file) => file.endsWith(`${LAYER_ID}.tsx`))).toBe(true)
  })

  it('never overwrites an existing module', () => {
    write(LAYER_REL, 'keep me\n')
    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'canvas-layer-create', nodeId: `canvas-layer:${LAYER_ID}`, layerId: LAYER_ID, element: { name: 'div' } }],
      {},
      allow,
    )
    expect(result.written).toBe(0)
    expect(result.refusals[0]?.reason).toBe('layer-exists')
    expect(read(LAYER_REL)).toBe('keep me\n')
  })

  it('refuses a malformed layer id at the wire — it can never become a path', () => {
    const edit = { kind: 'canvas-layer-create', nodeId: 'canvas-layer:x', layerId: '../../evil', element: { name: 'div' } }
    expect(Value.Check(StudioEditSchema, edit)).toBe(false)
    expect(Value.Check(StudioEditSchema, { ...edit, layerId: LAYER_ID })).toBe(true)
  })
})

describe('an agent batch never writes a loose layer (FC-1 decision)', () => {
  it('refuses every canvas-layer kind by name, and writes nothing', () => {
    const result = applyStudioEditBatch(wsDir, [
      { kind: 'canvas-layer-create', nodeId: `canvas-layer:${LAYER_ID}`, layerId: LAYER_ID, element: { name: 'div' } },
    ])
    expect(result.written).toBe(0)
    expect(result.refusals[0]?.reason).toBe('canvas-layer-agent')
    expect(exists(LAYER_REL)).toBe(false)
  })

  it('refuses a VALUE edit whose target is inside a layer module', () => {
    write(LAYER_REL, IMAGE_LAYER)
    const before = read(LAYER_REL)
    const result = applyStudioEditBatch(wsDir, [
      { kind: 'prop', nodeId: id(LAYER_REL, IMAGE_LAYER, 'img'), prop: 'alt', value: 'dog' } as StudioEdit,
    ])
    expect(result.refusals[0]?.reason).toBe('canvas-layer-agent')
    expect(read(LAYER_REL)).toBe(before)
  })

  it("refuses the agent's NATIVE Write/Edit into a layer module — the P4-C gate is unchanged", () => {
    expect(agentWriteRefusal(path.join(wsDir, '.studio', 'canvas', `${LAYER_ID}.tsx`), wsDir)?.code).toBe('protected-path')
    expect(agentWriteRefusal(`.studio/canvas/${LAYER_ID}.tsx`, wsDir)?.code).toBe('protected-path')
  })

  it('lets the editor write the same value edit', () => {
    write(LAYER_REL, IMAGE_LAYER)
    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'prop', nodeId: id(LAYER_REL, IMAGE_LAYER, 'img'), prop: 'alt', value: 'dog' } as StudioEdit],
      {},
      allow,
    )
    expect(result.refusals).toEqual([])
    expect(read(LAYER_REL)).toContain('alt="dog"')
  })
})

describe('canvas-layer-lift and canvas-layer-place round trip', () => {
  it('lifts an element out of a page into a new module, then places it back byte-exactly', () => {
    const lift = applyStudioEditBatch(
      wsDir,
      [{ kind: 'canvas-layer-lift', nodeId: id('pages/Home.tsx', HOME, 'Badge'), layerId: LAYER_ID }],
      {},
      allow,
    )
    expect(lift.refusals).toEqual([])
    expect(read(LAYER_REL)).toBe(`/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
import { Badge } from '../../components/Badge'

export default function CanvasLayer() {
  return (
    <Badge tone="quiet">New</Badge>
  )
}
`)
    // The element left the page, and the import it alone used went with it.
    const lifted = read('pages/Home.tsx')
    expect(lifted).not.toContain('<Badge')
    expect(lifted).not.toContain("import { Badge }")
    expect(lift.createdNodeIds).toEqual([`${LAYER_REL}:7:6`])

    const layerText = read(LAYER_REL)
    const place = applyStudioEditBatch(
      wsDir,
      [
        {
          kind: 'canvas-layer-place',
          nodeId: `${LAYER_REL}:7:6`,
          layerId: LAYER_ID,
          parentNodeId: id('pages/Home.tsx', lifted, 'main'),
        },
      ],
      {},
      allow,
    )
    expect(place.refusals).toEqual([])
    expect(exists(LAYER_REL)).toBe(false)
    expect(place.removed).toEqual([{ nodeId: `${LAYER_REL}:7:6`, text: layerText, wholeLine: false }])
    // Back in the page, with its import carried: the page's original bytes.
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('a place COPY leaves the module on the canvas', () => {
    write(LAYER_REL, IMAGE_LAYER)
    const result = applyStudioEditBatch(
      wsDir,
      [
        {
          kind: 'canvas-layer-place',
          nodeId: id(LAYER_REL, IMAGE_LAYER, 'img'),
          layerId: LAYER_ID,
          parentNodeId: id('pages/Home.tsx', HOME, 'main'),
          copy: true,
        },
      ],
      {},
      allow,
    )
    expect(result.refusals).toEqual([])
    expect(read(LAYER_REL)).toBe(IMAGE_LAYER)
    expect(read('pages/Home.tsx')).toContain('<img src="/cat.png"')
  })

  it('refuses a place whose root is not in the module its layerId names', () => {
    write(LAYER_REL, IMAGE_LAYER)
    write('.studio/canvas/clabcdefghij.tsx', IMAGE_LAYER)
    const result = applyStudioEditBatch(
      wsDir,
      [
        {
          kind: 'canvas-layer-place',
          nodeId: id('.studio/canvas/clabcdefghij.tsx', IMAGE_LAYER, 'img'),
          layerId: LAYER_ID,
          parentNodeId: id('pages/Home.tsx', HOME, 'main'),
        },
      ],
      {},
      allow,
    )
    expect(result.written).toBe(0)
    expect(read(LAYER_REL)).toBe(IMAGE_LAYER)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })
})

describe('canvas-layer-delete and canvas-layer-restore', () => {
  it('deletes a module, reports its bytes, and a restore writes them back exactly', () => {
    write(LAYER_REL, IMAGE_LAYER)
    const deleted = applyStudioEditBatch(
      wsDir,
      [{ kind: 'canvas-layer-delete', nodeId: `canvas-layer:${LAYER_ID}`, layerId: LAYER_ID }],
      {},
      allow,
    )
    expect(exists(LAYER_REL)).toBe(false)
    expect(deleted.removed).toEqual([{ nodeId: `canvas-layer:${LAYER_ID}`, text: IMAGE_LAYER, wholeLine: false }])

    const restored = applyStudioEditBatch(
      wsDir,
      [{ kind: 'canvas-layer-restore', nodeId: `canvas-layer:${LAYER_ID}`, layerId: LAYER_ID, text: IMAGE_LAYER }],
      {},
      allow,
    )
    expect(restored.refusals).toEqual([])
    expect(read(LAYER_REL)).toBe(IMAGE_LAYER)
  })

  it('refuses to write through a .studio/canvas that is a link', () => {
    const target = path.join(wsDir, 'pages')
    fs.mkdirSync(path.join(wsDir, '.studio'), { recursive: true })
    fs.symlinkSync(target, path.join(wsDir, '.studio', 'canvas'), 'junction')
    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'canvas-layer-create', nodeId: `canvas-layer:${LAYER_ID}`, layerId: LAYER_ID, element: { name: 'div' } }],
      {},
      allow,
    )
    expect(result.written).toBe(0)
    expect(fs.existsSync(path.join(target, `${LAYER_ID}.tsx`))).toBe(false)
  })
})

describe('loading: loose layers travel outside the pages (G-EX-2)', () => {
  it('returns layers in canvasLayers, never in pages, and a narrowed load still carries them', async () => {
    write(LAYER_REL, IMAGE_LAYER)
    const full = await loadStudioPages(wsDir)
    expect(full.pages.map((page) => page.id)).toEqual(['home'])
    expect(full.canvasLayers.map((layer) => layer.pageId)).toEqual([`canvas:${LAYER_ID}`])
    const img = Object.values(full.canvasLayers[0]!.page.nodes).find((node) => node.id === `${LAYER_REL}:6:6`)
    expect(img).toBeDefined()

    const narrow = await loadStudioPages(wsDir, { pageIds: ['home'] })
    expect(narrow.canvasLayers).toEqual(full.canvasLayers)
  })

  it('a layer written outside Studio invalidates the load memo', async () => {
    const before = await loadStudioPages(wsDir)
    expect(before.canvasLayers).toEqual([])
    write(LAYER_REL, IMAGE_LAYER)
    const after = await loadStudioPages(wsDir)
    expect(after.canvasLayers).toHaveLength(1)
  })

  it('ignores a stray file in .studio/canvas that is not a layer module', async () => {
    write('.studio/canvas/notes.tsx', IMAGE_LAYER)
    write('.studio/canvas/CL0123456789.tsx', IMAGE_LAYER)
    const result = await loadStudioPages(wsDir)
    expect(result.canvasLayers).toEqual([])
  })

  it('narrows a reload after a layer write to the layer, not the whole board', async () => {
    write(LAYER_REL, IMAGE_LAYER)
    await loadStudioPages(wsDir)
    const url = new URL('http://localhost/admin/api/studio/reload-scope')
    const res = await tryServeStudioReloadScope(
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: wsDir, files: [LAYER_REL, 'pages/Home.tsx'] }) }),
      url,
      url.pathname,
    )
    const body = (await res!.json()) as { narrow: boolean; pageIds?: string[] }
    expect(body.narrow).toBe(true)
    expect(body.pageIds?.sort()).toEqual([`canvas:${LAYER_ID}`, 'home'])
  })
})
