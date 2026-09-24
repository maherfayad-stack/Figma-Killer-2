import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P5-G — the free canvas, end to end, against the bytes on disk (design §8
 * test 8; the owner's ask, OD-14): *"a free canvas that I can drag an image
 * in, and it's not part of the pages, and it's still there, just not part of
 * the live preview."*
 *
 * One continuous story, because each step's precondition is the previous
 * step's result:
 *
 *   1. an image file dropped on the EMPTY board becomes a loose layer — a
 *      module in `.studio/canvas/` and a placement in `boards.json` — and after
 *      a full reload it is still there, rendered where it was dropped;
 *   2. it is in NO page file, and nothing the running app builds from
 *      (`prototype/registry.generated.jsx`, every source file's imports)
 *      reaches it — the live preview cannot show what it cannot import;
 *   3. dragged into a frame, it becomes page JSX and leaves the canvas (module
 *      deleted, placement removed);
 *   4. dragged back out of the frame onto the board, it becomes a loose layer
 *      again, and the page file is BYTE-IDENTICAL to what it was before any of
 *      this happened.
 *
 * Every assertion reads the files (or computed layout from a real browser),
 * never the store: the claim is about what is on disk and on screen.
 */

/** A 64x48 opaque PNG, generated in the page (a real decodable image, so the intrinsic size is real). */
const IMAGE_SIZE = { width: 64, height: 48 }
const DROPPED_FILE_NAME = 'free-canvas-cat.png'

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main className="home">
      <h1 className="home__title">Free canvas</h1>
      <p className="home__body">Drop target</p>
    </main>
  )
}
`

const FIXTURE_CSS = `.home { display: flex; flex-direction: column; gap: 24px; padding: 40px; min-height: 480px; background: #ffffff; }
.home__title { margin: 0; font-size: 32px; }
.home__body { margin: 0; font-size: 16px; }
`

let fixture: FixtureProject

const rel = (...segments: string[]) => path.join(fixture.dir, ...segments)
const readPage = (): string => fs.readFileSync(rel('pages', 'Home.jsx'), 'utf8')
const layerModules = (): string[] => {
  const dir = rel('.studio', 'canvas')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^cl[a-z0-9]{10}\.tsx$/.test(name)) : []
}
const readBoards = (): { boards: { layers?: { id: string; x: number; y: number }[] }[] } =>
  JSON.parse(fs.readFileSync(rel('.studio', 'boards.json'), 'utf8'))
const placements = () => readBoards().boards.flatMap((board) => board.layers ?? [])

/** Every file of the project a build could reach — everything but Studio's own sidecar and generated shell. */
function appFiles(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (abs: string, prefix: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.studio' || entry.name === 'node_modules' || entry.name === 'prototype') continue
      const child = path.join(abs, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child, name)
      else out.set(name, fs.readFileSync(child, 'utf8'))
    }
  }
  walk(fixture.dir, '')
  return out
}

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-free-canvas', {
    'pages/Home.jsx': FIXTURE_PAGE,
    'pages/home.css': FIXTURE_CSS,
    'public/.gitkeep': '',
    'package.json': JSON.stringify({ name: 'free-canvas-fixture', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify({ displayName: 'Zz Free Canvas Fixture', platform: 'web', pagesDir: 'pages', frameDefaults: { width: 900, height: 600 } }, null, 2) + '\n',
    '.studio/boards.json':
      JSON.stringify(
        {
          version: 1,
          boards: [{ id: 'board-1', name: 'Board 1', frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0, width: 900, height: 600 }], notes: [], docs: [] }],
        },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

/** Drop a real PNG, built in the page's realm, on the canvas root at a client point. */
async function dropImageAt(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.getByTestId('canvas-root').evaluate(
    async (root, args) => {
      const canvas = document.createElement('canvas')
      canvas.width = args.width
      canvas.height = args.height
      const context = canvas.getContext('2d')!
      context.fillStyle = '#d2691e'
      context.fillRect(0, 0, args.width, args.height)
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], args.name, { type: 'image/png' }))
      for (const type of ['dragover', 'drop']) {
        root.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: args.x, clientY: args.y, dataTransfer: transfer }),
        )
      }
    },
    { ...IMAGE_SIZE, name: DROPPED_FILE_NAME, x: point.x, y: point.y },
  )
}

/** The loose layer's rendered <img>, inside the free-canvas surface. */
function layerImage(page: Page, layerId: string): Locator {
  return page.frameLocator('iframe[data-studio-canvas-surface-frame]').locator(`[data-studio-layer-id="${layerId}"] img`)
}

/** A real mouse drag with intermediate moves, the way a hand does it. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 16): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
}

const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

test.describe('the free canvas', () => {
  test.setTimeout(300_000)

  test('an image on the empty board persists, stays out of the app, goes into a frame and back out', async ({ page }) => {
    const pageBefore = readPage()
    const appBefore = appFiles()

    // ── 1. Drop an image on the empty board ────────────────────────────────
    let canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = await frameForPage(page, canvasRoot, 'home')
    const frameBox = (await frame.boundingBox())!
    const rootBox = (await canvasRoot.boundingBox())!
    // Right of the frame, inside the canvas: empty board.
    const dropPoint = { x: Math.min(frameBox.x + frameBox.width + 160, rootBox.x + rootBox.width - 80), y: frameBox.y + 120 }
    await dropImageAt(page, dropPoint)

    await expect.poll(layerModules, { timeout: 60_000, message: 'no layer module was written to .studio/canvas' }).toHaveLength(1)
    const layerId = layerModules()[0]!.replace(/\.tsx$/, '')
    const moduleText = fs.readFileSync(rel('.studio', 'canvas', `${layerId}.tsx`), 'utf8')
    expect(moduleText.startsWith('/* eslint-disable */\n')).toBe(true)
    expect(moduleText).toMatch(new RegExp(`<img src="/[^"]+\\.png" alt="free-canvas-cat" width=\\{${IMAGE_SIZE.width}\\} height=\\{${IMAGE_SIZE.height}\\} />`))
    // The placement reaches boards.json through the board autosave.
    await expect.poll(() => placements().map((layer) => layer.id), { timeout: 30_000 }).toEqual([layerId])

    // ── 2. Not part of any page, nor of anything the app builds from ───────
    expect(readPage(), 'dropping on the empty board wrote into a page').toBe(pageBefore)
    const appAfter = appFiles()
    for (const [name, text] of appBefore) expect(appAfter.get(name), `${name} changed`).toBe(text)
    const added = [...appAfter.keys()].filter((name) => !appBefore.has(name))
    expect(added.every((name) => name.startsWith('public/') && name.endsWith('.png')), `unexpected new app files: ${added}`).toBe(true)
    for (const [name, text] of appAfter) expect(text.includes('.studio/'), `${name} reaches into .studio/`).toBe(false)
    const registry = fs.readFileSync(rel('prototype', 'registry.generated.jsx'), 'utf8')
    expect(registry, 'the live preview registry names the loose layer').not.toContain(layerId)

    // ── 1b. Still there after a full reload, where it was dropped ──────────
    await page.reload()
    canvasRoot = page.getByTestId('canvas-root')
    await expect(canvasRoot).toBeVisible({ timeout: 60_000 })
    const image = layerImage(page, layerId)
    await expect(image, 'the loose layer did not come back after a reload').toBeVisible({ timeout: 60_000 })
    const naturalSize = await image.evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight }))
    expect(naturalSize).toEqual(IMAGE_SIZE)

    // ── 3. Drag it into the frame ──────────────────────────────────────────
    const homeFrame = await frameForPage(page, canvasRoot, 'home')
    const content = homeFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    const target = content.locator('.home__body')
    await expect(target).toBeVisible({ timeout: 30_000 })
    const imageBox = (await image.boundingBox())!
    const targetBox = (await target.boundingBox())!
    await drag(page, centre(imageBox), { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height - 2 })

    await expect.poll(readPage, { timeout: 60_000, message: 'the layer never reached the page source' }).toContain('<img')
    await expect.poll(layerModules, { timeout: 30_000, message: 'the module stayed on the canvas after a move into the frame' }).toEqual([])
    await expect.poll(() => placements(), { timeout: 30_000 }).toEqual([])
    const placedImage = content.locator('img')
    await expect(placedImage).toBeVisible({ timeout: 30_000 })
    // Computed layout: the element now renders INSIDE the frame's iframe.
    const frameIframeBox = (await homeFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR).boundingBox())!
    const placedBox = (await placedImage.boundingBox())!
    expect(placedBox.x).toBeGreaterThanOrEqual(frameIframeBox.x - 1)
    expect(placedBox.x + placedBox.width).toBeLessThanOrEqual(frameIframeBox.x + frameIframeBox.width + 1)

    // ── 4. Drag it back out onto the empty board ───────────────────────────
    const outBox = (await placedImage.boundingBox())!
    const freshRoot = (await canvasRoot.boundingBox())!
    const freshFrame = (await homeFrame.boundingBox())!
    const outPoint = { x: Math.min(freshFrame.x + freshFrame.width + 200, freshRoot.x + freshRoot.width - 60), y: freshFrame.y + 160 }
    await drag(page, centre(outBox), outPoint)

    await expect.poll(layerModules, { timeout: 60_000, message: 'the element never left the frame for the canvas' }).toHaveLength(1)
    await expect.poll(readPage, { timeout: 60_000 }).not.toContain('<img')
    // Byte-exact: the page is exactly what it was before the image ever existed.
    expect(readPage()).toBe(pageBefore)
    await expect.poll(() => placements().length, { timeout: 30_000 }).toBe(1)
  })
})
