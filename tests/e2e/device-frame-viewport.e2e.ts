import { expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * O11 — a device frame is the device: a 393 x 852 frame has an iframe viewport
 * of exactly 393 x 852 whatever the editor window is, and content taller than
 * that scrolls INSIDE the frame instead of stretching it.
 *
 * Asserted in a real browser on computed values (the frame box, the iframe box
 * and `innerHeight`/`innerWidth` read inside the iframe), after resizing the
 * editor window, with a short page and a tall page.
 */

let fixture: FixtureProject

const SHORT = `export default function Home() {
  return (
    <main style={{ minHeight: "100vh", background: "#eef" }}>
      <p>Short screen</p>
    </main>
  )
}
`
const TALL = `export default function Home() {
  return (
    <main style={{ height: "2000px", background: "linear-gradient(#eef, #fee)" }}>
      <p>Tall screen</p>
    </main>
  )
}
`

function author(source: string) {
  fixture = createAuthoredFixtureProject('__e2e-device-frame-viewport', {
    'pages/Home.tsx': source,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
    '.studio/boards.json':
      JSON.stringify(
        {
          version: 1,
          boards: [
            {
              id: 'board-1',
              name: 'Board 1',
              frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0, width: 393, height: 852 }],
              notes: [],
              docs: [],
              layers: [],
            },
          ],
        },
        null,
        2,
      ) + '\n',
  })
}

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function measure(page: Page) {
  const frame = page.locator('[data-page-id="home"]').first()
  const body = frame.getByTestId('board-frame-body')
  const iframe = visibleCanvasIframe(frame)
  const zoom = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="board-frames-layer"]') as HTMLElement | null
    const t = el ? getComputedStyle(el).transform : 'none'
    return t === 'none' ? 1 : new DOMMatrixReadOnly(t).a
  })
  const bodyBox = (await body.boundingBox())!
  const iframeBox = (await iframe.boundingBox())!
  const inner = await iframe.evaluate((el) => {
    const win = (el as HTMLIFrameElement).contentWindow!
    return { innerHeight: win.innerHeight, innerWidth: win.innerWidth }
  })
  return { zoom, bodyHeight: bodyBox.height / zoom, bodyWidth: bodyBox.width / zoom, iframeHeight: iframeBox.height / zoom, ...inner }
}

for (const [name, source] of [['short', SHORT], ['tall', TALL]] as const) {
  test(`${name} page in a 393x852 device frame: the viewport is the device, not the editor window`, async ({ page }) => {
    test.setTimeout(180_000)
    author(source)
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = page.locator('[data-page-id="home"]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(1500)

    for (const windowHeight of [960, 900]) {
      await page.setViewportSize({ width: 1280, height: windowHeight })
      await page.waitForTimeout(1200)
      const m = await measure(page)
      expect(m, `window ${windowHeight}: ${JSON.stringify(m)}`).toMatchObject({ innerWidth: 393, innerHeight: 852 })
      expect(Math.abs(m.bodyHeight - 852), `frame box height ${m.bodyHeight}`).toBeLessThanOrEqual(1)
      expect(Math.abs(m.iframeHeight - 852), `iframe height ${m.iframeHeight}`).toBeLessThanOrEqual(1)
    }
    // The stored size is untouched by looking at it.
    const stored = JSON.parse(fs.readFileSync(path.join(fixture.dir, '.studio', 'boards.json'), 'utf8')) as {
      boards: Array<{ frames: Array<{ width: number; height: number }> }>
    }
    expect(stored.boards[0]!.frames[0]).toMatchObject({ width: 393, height: 852 })
  })
}
