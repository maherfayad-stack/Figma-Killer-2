import { expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  readToastRecorder,
  removeFixtureProject,
  sourceNodeId,
  startToastRecorder,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P5-A — one paste pipeline, in a real Chromium, with the REAL OS clipboard
 * and a real ⌘V keystroke.
 *
 * The defect: ⌘V's keydown called `preventDefault()`, which cancels the
 * browser's paste itself — so no `paste` event ever fired, and nothing on the
 * OS clipboard (a screenshot, "Copy image") could be read. The keydown now
 * only arms the paste; the `paste` event raised INSIDE the frame document
 * (focus is there after the click that selects a layer) reaches the clipboard
 * bridge, and one decision picks layers / SVG / image:
 *
 *   1. an image on the clipboard lands through the file drop's own write: the
 *      bytes in `public/`, an `<img>` in the page source, after the selection;
 *   2. a copied LAYER still pastes as the layer (P3-D's path), because ⌘C
 *      wrote the Studio marker onto the OS clipboard through the `copy` event;
 *   3. an image copied AFTER that layer wins — the marker is gone, so the
 *      clipboard holds something newer than the copy.
 *
 * Nothing here is synthesised: the image is written with the async Clipboard
 * API (permissions granted to the context), and the paste is a keystroke.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main className="home" style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "32px", minHeight: "480px" }}>
      <h1 className="home__title">Paste target</h1>
      <p className="home__body">Select me, then paste.</p>
    </main>
  )
}
`

const PAGE_REL = 'pages/Home.jsx'
// By source id, not class: a class with no stylesheet rule is not rendered on the canvas.
const TITLE = `[data-node-id="${sourceNodeId(FIXTURE_PAGE, PAGE_REL, 'h1')}"]`
const BODY = `[data-node-id="${sourceNodeId(FIXTURE_PAGE, PAGE_REL, 'p')}"]`
let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, ...PAGE_REL.split('/')), 'utf8')
const landedPngs = () => fs.readdirSync(path.join(fixture.dir, 'public')).filter((name) => name.endsWith('.png'))

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-canvas-paste', {
    [PAGE_REL]: FIXTURE_PAGE,
    'public/.gitkeep': '',
    'package.json': JSON.stringify({ name: 'canvas-paste-fixture', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify(
        {
          displayName: 'Zz Canvas Paste Fixture',
          platform: 'web',
          pagesDir: 'pages',
          frameDefaults: { width: 900, height: 600 },
          // The DESIGN frame's bridge is under test (see frame-file-drop.e2e.ts).
          trust: 'static',
        },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openHome(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const boardFrame = page.locator('[data-page-id]').first()
  await expect(visibleCanvasIframe(boardFrame), 'no design frame mounted').toHaveCount(1, { timeout: 60_000 })
  await expect(canvasRoot).toBeVisible()
  await startToastRecorder(page)
  return canvasContentFrame(boardFrame)
}

/** Put a PNG on the OS clipboard, as a screenshot or "Copy image" would. */
async function copyImageToOsClipboard(page: Page): Promise<void> {
  await page.evaluate(async (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, PNG_BASE64)
}

async function withToasts<T>(page: Page, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${String(error)}\ntoasts: ${JSON.stringify(await readToastRecorder(page))}`, { cause: error })
  }
}

test.describe('P5-A — ⌘V is driven by the paste event', () => {
  test.setTimeout(240_000)

  test('an image on the OS clipboard pastes as an <img>: bytes in public/, the element after the selection', async ({ page }) => {
    const frame = await openHome(page)
    await clickInFrame(page, frame.locator(BODY).first())
    await copyImageToOsClipboard(page)

    await page.keyboard.press('Control+v')

    await withToasts(page, async () => {
      await expect.poll(landedPngs, { timeout: 60_000, message: 'the pasted image never reached public/' }).toHaveLength(1)
      await expect
        .poll(readPage, { timeout: 60_000, message: 'the image landed but no <img> reached the source' })
        .toMatch(/<p className="home__body">Select me, then paste\.<\/p>\s*<img[^>]*src="\/[^"]+\.png"/)
    })
    expect(readPage()).toContain('<h1 className="home__title">Paste target</h1>')
  })

  test('a copied layer pastes as the layer — ⌘C marked the OS clipboard through the copy event', async ({ page }) => {
    const frame = await openHome(page)
    await clickInFrame(page, frame.locator(TITLE).first())
    await page.keyboard.press('Control+c')

    // The copy event wrote the Studio marker onto the real OS clipboard.
    const html = await page.evaluate(async () => {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) return (await item.getType('text/html')).text()
      }
      return ''
    })
    expect(html, 'the copy wrote no Studio marker to the OS clipboard').toMatch(/data-studio-nodes="\d+"/)

    await clickInFrame(page, frame.locator(BODY).first())
    await page.keyboard.press('Control+v')

    await withToasts(page, () =>
      expect
        .poll(() => readPage().match(/<h1 className="home__title">Paste target<\/h1>/g)?.length ?? 0, {
          timeout: 30_000,
          message: 'the copied layer was never pasted',
        })
        .toBe(2),
    )
    expect(landedPngs(), 'a layer paste uploaded an image').toEqual([])
  })

  test('an image copied AFTER a layer wins the next ⌘V — the clipboard holds something newer', async ({ page }) => {
    const frame = await openHome(page)
    await clickInFrame(page, frame.locator(TITLE).first())
    await page.keyboard.press('Control+c')
    await copyImageToOsClipboard(page)

    await clickInFrame(page, frame.locator(BODY).first())
    await page.keyboard.press('Control+v')

    await withToasts(page, async () => {
      await expect.poll(landedPngs, { timeout: 60_000 }).toHaveLength(1)
      await expect.poll(readPage, { timeout: 60_000 }).toContain('<img')
    })
    expect(readPage().match(/<h1 className="home__title">/g), 'the stale layer was pasted as well').toHaveLength(1)
  })
})
