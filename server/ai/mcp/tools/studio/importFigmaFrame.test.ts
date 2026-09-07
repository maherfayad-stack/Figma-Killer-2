/**
 * `studio_import_figma_frame` — handler coverage against a real temp project
 * directory with real sharp-encoded PNG bytes and a real `.studio/boards.json`,
 * plus the pure `detectScreens` discriminator on its own.
 *
 * The cases that matter here are the ones the tool exists for: the board frame
 * really lands on `absoluteBoundingBox` (the resample class this whole row is
 * about), a section is enumerated rather than sized, and one leg failing does
 * not take the others down with it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sharp from 'sharp'
import { parseValue } from '@core/utils/typeboxHelpers'
import { detectScreens, studioImportFigmaFrameMcpTools } from './importFigmaFrame'
import { autoPlaceBoardFrame, readBoardsFile } from '../../../../handlers/studio/boardFrames'
import { listDesignVariableSets } from '../../../../handlers/studio/designVariableStore'
import { listDesignReferences } from '../../../../handlers/studio/designReferenceStore'

const tool = studioImportFigmaFrameMcpTools[0]!

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-figma-frame-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function writePng(rel: string, width: number, height: number): Promise<string> {
  const abs = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  await sharp({ create: { width, height, channels: 4, background: { r: 7, g: 8, b: 9, alpha: 1 } } })
    .png()
    .toFile(abs)
  return abs
}

interface ImportResult {
  ok: boolean
  error?: string
  figma?: { url: string | null; fileKey: string | null; nodeId: string | null; note?: string }
  frame?: { status: string; width: number | null; height: number | null; note?: string }
  reference?: { status: string; note?: string; reference?: { id: string; width: number; height: number; mode?: string; role?: string; pageId?: string; source?: string } }
  variables?: { status: string; id?: string; variableCount?: number; colorCount?: number }
  screenDetection?: string
  screens?: Array<{ name: string; nodeId: string | null; width: number; height: number }>
  hiddenLayers?: { count: number; names: string[]; omittedNames?: number } | null
}

function run(input: Record<string, unknown>): Promise<ImportResult> {
  return tool.handler!({ dir, ...input }, {} as never) as Promise<ImportResult>
}

const PAGE_ID = 'src/screens/Checkout.tsx'

function frameSizeFor(pageId: string): { width?: number; height?: number } | null {
  for (const board of readBoardsFile(dir).boards) {
    const frame = board.frames.find((f) => f.pageId === pageId)
    if (frame) return { width: frame.width, height: frame.height }
  }
  return null
}

// ---------------------------------------------------------------------------

describe('tool shape', () => {
  it('is a headless, capability-gated mutator with an object input schema', () => {
    expect(tool.name).toBe('studio_import_figma_frame')
    expect(tool.execution).toBe('server')
    expect(tool.mutates).toBe(true)
    expect(tool.requiredCapabilities).toEqual(['studio.write'])
    expect(tool.inputSchema.type).toBe('object')
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
  })

  it('never advertises a `dir`-like field that could redirect a destructive write', () => {
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual(['dir', 'exportPath', 'label', 'mode', 'node', 'pageId', 'url', 'variables'].sort())
  })
})

describe('the TypeBox boundary', () => {
  it('accepts a raw Figma metadata node with its extra fields intact', () => {
    expect(() =>
      parseValue(tool.inputSchema, {
        pageId: PAGE_ID,
        node: {
          id: '1:2',
          name: 'Checkout',
          type: 'FRAME',
          fills: [{ type: 'SOLID' }],
          absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
          children: [{ id: '1:3', name: 'Header', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 64 } }],
        },
      }),
    ).not.toThrow()
  })

  it('strips an unknown top-level field before the handler ever sees it — additionalProperties:false means a future schema addition cannot be smuggled in', () => {
    expect(parseValue(tool.inputSchema, { pageId: PAGE_ID, outputDir: '/etc' })).toEqual({ pageId: PAGE_ID })
  })

  it('rejects a missing pageId', () => {
    expect(() => parseValue(tool.inputSchema, { url: 'https://figma.com/design/K/S' })).toThrow()
  })
})

describe('nothing to import', () => {
  it('refuses with a message naming all three inputs it could have taken', async () => {
    const result = await run({ pageId: PAGE_ID, url: 'https://figma.com/design/K/S?node-id=1-2' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exportPath')
    expect(result.error).toContain('node')
    expect(result.error).toContain('variables')
  })
})

describe('the board frame lands on absoluteBoundingBox', () => {
  it('resizes the page frame to the Figma frame\'s own size', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({
      pageId: PAGE_ID,
      node: { id: '1:2', name: 'Checkout', type: 'FRAME', absoluteBoundingBox: { width: 390.4, height: 843.6 } },
    })
    expect(result.ok).toBe(true)
    expect(result.frame).toMatchObject({ status: 'resized', width: 390, height: 844 })
    expect(frameSizeFor(PAGE_ID)).toEqual({ width: 390, height: 844 })
  })

  it('reports already-matched rather than rewriting an identical size', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const node = { id: '1:2', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } }
    await run({ pageId: PAGE_ID, node })
    const second = await run({ pageId: PAGE_ID, node })
    expect(second.frame?.status).toBe('already-matched')
  })

  it('names the missing precondition when no board frame exists for the page', async () => {
    const result = await run({
      pageId: 'src/screens/Nope.tsx',
      node: { type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } },
    })
    expect(result.frame?.status).toBe('no-frame-for-page')
    expect(result.frame?.note).toContain('studio_list_pages')
  })

  it('refuses an absurd bounding box instead of writing it to the board', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({ pageId: PAGE_ID, node: { type: 'FRAME', absoluteBoundingBox: { width: 0, height: 90000 } } })
    expect(result.frame?.status).toBe('out-of-range')
    expect(frameSizeFor(PAGE_ID)?.width).not.toBe(0)
  })

  it('says so, with the consequence, when the metadata carries no bounding box', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({ pageId: PAGE_ID, node: { type: 'FRAME', name: 'Checkout' } })
    expect(result.frame?.status).toBe('no-bounding-box')
    expect(result.frame?.note).toContain('resampled')
  })
})

describe('the design reference', () => {
  it('registers the export as a role:spec, mode:strict reference scoped to the page, with the url as provenance', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    await writePng('.studio/figma/checkout.png', 390, 844)
    const url = 'https://www.figma.com/design/FILEKEY/Shop?node-id=53958-5861'
    const result = await run({
      pageId: PAGE_ID,
      url,
      exportPath: '.studio/figma/checkout.png',
      node: { name: 'Checkout', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } },
    })
    expect(result.reference?.status).toBe('registered')
    expect(result.reference?.reference).toMatchObject({
      width: 390,
      height: 844,
      mode: 'strict',
      role: 'spec',
      pageId: PAGE_ID,
      source: url,
      label: 'Checkout',
    })
    expect(listDesignReferences(dir, PAGE_ID, undefined).references).toHaveLength(1)
    expect(result.figma).toMatchObject({ fileKey: 'FILEKEY', nodeId: '53958:5861' })
  })

  it('honours an explicit non-strict mode', async () => {
    await writePng('a.png', 10, 10)
    const result = await run({ pageId: PAGE_ID, exportPath: 'a.png', mode: 'balanced' })
    expect(result.reference?.reference?.mode).toBe('balanced')
  })

  it('a missing export does not take the frame resize down with it', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({
      pageId: PAGE_ID,
      exportPath: 'nope/missing.png',
      node: { type: 'FRAME', absoluteBoundingBox: { width: 375, height: 812 } },
    })
    expect(result.ok).toBe(true)
    expect(result.reference?.status).toBe('failed')
    expect(result.frame?.status).toBe('resized')
    expect(frameSizeFor(PAGE_ID)).toEqual({ width: 375, height: 812 })
  })

  it('says what is missing, and what it costs, when no export was passed at all', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({ pageId: PAGE_ID, node: { type: 'FRAME', absoluteBoundingBox: { width: 375, height: 812 } } })
    expect(result.reference?.status).toBe('not-provided')
    expect(result.reference?.note).toContain('studio_compare')
  })
})

describe('design variables', () => {
  it('ingests the table scoped to the page AND the reference it just registered', async () => {
    await writePng('a.png', 10, 10)
    const result = await run({
      pageId: PAGE_ID,
      exportPath: 'a.png',
      url: 'https://figma.com/design/K/S?node-id=1-2',
      variables: [
        { name: 'coral/100', value: '#ff5533', figmaType: 'COLOR' },
        { name: 'spacing/md', value: 16, figmaType: 'FLOAT' },
      ],
    })
    expect(result.variables).toMatchObject({ status: 'ingested', variableCount: 2, colorCount: 1 })
    const sets = listDesignVariableSets(dir, { pageId: PAGE_ID }, undefined).sets
    expect(sets).toHaveLength(1)
    expect(sets[0]!.referenceId).toBe(result.reference!.reference!.id)
    expect(sets[0]!.source).toBe('https://figma.com/design/K/S?node-id=1-2')
  })

  it('still ingests when there is no reference to scope to', async () => {
    const result = await run({ pageId: PAGE_ID, variables: [{ name: 'x', value: '#000' }] })
    expect(result.variables?.status).toBe('ingested')
    expect(listDesignVariableSets(dir, { pageId: PAGE_ID }, undefined).sets[0]!.referenceId).toBeUndefined()
  })
})

describe('hidden layers', () => {
  it('counts and names visible:false layers at any depth, without descending into them', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({
      pageId: PAGE_ID,
      node: {
        type: 'FRAME',
        absoluteBoundingBox: { width: 390, height: 844 },
        children: [
          { name: 'Old banner', type: 'FRAME', visible: false, children: [{ name: 'buried', type: 'TEXT', visible: false }] },
          { name: 'Header', type: 'FRAME', children: [{ name: 'Debug grid', type: 'FRAME', visible: false }] },
        ],
      },
    })
    // 'buried' sits under an already-hidden layer, so it is not counted twice.
    expect(result.hiddenLayers?.count).toBe(2)
    expect(result.hiddenLayers?.names.sort()).toEqual(['Debug grid', 'Old banner'])
  })

  it('reports zero hidden layers without a note when everything is visible', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({ pageId: PAGE_ID, node: { type: 'FRAME', absoluteBoundingBox: { width: 10, height: 10 } } })
    expect(result.hiddenLayers?.count).toBe(0)
  })
})

describe('detectScreens — section vs single screen', () => {
  const screen = (name: string, id: string) => ({
    id,
    name,
    type: 'FRAME',
    absoluteBoundingBox: { width: 390, height: 844 },
  })

  it('enumerates sibling screen-sized frames as N screens', () => {
    const result = detectScreens({
      type: 'SECTION',
      absoluteBoundingBox: { width: 1400, height: 900 },
      children: [screen('Cart', '1:1'), screen('Checkout', '1:2'), screen('Receipt', '1:3')],
    })
    expect(result.detection).toBe('section-of-screens')
    expect(result.screens.map((s) => s.name)).toEqual(['Cart', 'Checkout', 'Receipt'])
    expect(result.screens[0]).toEqual({ name: 'Cart', nodeId: '1:1', width: 390, height: 844 })
  })

  it('reads a single screen with stacked sections as ONE frame, not a section', () => {
    const result = detectScreens({
      type: 'FRAME',
      absoluteBoundingBox: { width: 390, height: 2000 },
      children: [
        { name: 'Hero', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 600 } },
        { name: 'Features', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 700 } },
      ],
    })
    expect(result.detection).toBe('single-frame')
    expect(result.screens).toEqual([])
  })

  it('ignores hidden and undersized children when counting screens', () => {
    const result = detectScreens({
      type: 'SECTION',
      absoluteBoundingBox: { width: 1400, height: 900 },
      children: [
        screen('Cart', '1:1'),
        { ...screen('Hidden', '1:2'), visible: false },
        { name: 'Chip', type: 'FRAME', absoluteBoundingBox: { width: 80, height: 900 } },
      ],
    })
    expect(result.detection).toBe('single-frame')
  })

  it('degrades honestly with no bounding box to compare against', () => {
    expect(detectScreens({ type: 'SECTION', children: [] }).detection).toBe('no-bounding-box')
  })
})

describe('a section is enumerated, never sized', () => {
  it('leaves the board frame alone and tells the agent to make one page per screen', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const before = frameSizeFor(PAGE_ID)
    const result = await run({
      pageId: PAGE_ID,
      node: {
        type: 'SECTION',
        name: 'Shop flow',
        absoluteBoundingBox: { width: 1400, height: 900 },
        children: [
          { id: '1:1', name: 'Cart', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } },
          { id: '1:2', name: 'Checkout', type: 'FRAME', absoluteBoundingBox: { width: 390, height: 844 } },
        ],
      },
    })
    expect(result.screenDetection).toBe('section-of-screens')
    expect(result.frame?.status).toBe('section-not-sized')
    expect(result.frame?.note).toContain('one Studio page per screen')
    expect(result.screens).toHaveLength(2)
    expect(frameSizeFor(PAGE_ID)).toEqual(before!)
  })
})

describe('the url is provenance, never a fetch', () => {
  it('reports a non-figma url as unparseable without failing the import', async () => {
    autoPlaceBoardFrame(dir, PAGE_ID)
    const result = await run({
      pageId: PAGE_ID,
      url: 'https://example.com/mock.png',
      node: { type: 'FRAME', absoluteBoundingBox: { width: 100, height: 200 } },
    })
    expect(result.ok).toBe(true)
    expect(result.figma).toMatchObject({ url: 'https://example.com/mock.png', fileKey: null, nodeId: null })
    expect(result.figma?.note).toContain('not a recognisable Figma file URL')
  })

  it('never echoes a placeholder node id back as if it were resolvable', async () => {
    const result = await run({
      pageId: PAGE_ID,
      url: 'https://www.figma.com/design/ABC123/S?node-id=REPLACE-ME',
      variables: [{ name: 'x', value: '#000' }],
    })
    expect(result.figma).toMatchObject({ fileKey: 'ABC123', nodeId: null })
  })
})
