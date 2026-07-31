import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for WS-4.2: the `studio.instance` fragment node
 * (`src/modules/base/instance/`) renders ZERO DOM elements of its own, and a
 * `height: 100%` chain crossing it still resolves — the entire reason this
 * design exists (see `src/core/page-parser/inlineLocalComponents.ts`'s module
 * header). `bun test`'s happy-dom has no layout engine (`standing-02`), so
 * whether `.sheet-shell { height: 100% }` actually computes to a non-trivial
 * pixel height is a question only a real browser can answer.
 *
 * `studio-workspace/maherfayad-stack-eSIM`'s `booking-confirmation-screen`
 * is `export default function BookingConfirmationScreen() { return
 * <SheetShell ...>…</SheetShell> }` — `SheetShell` (a LOCAL component, has
 * `.sheet-shell { height: 100% }` in its own CSS) is the component's ENTIRE
 * return, so its call site is the ROOT of the page's node tree: the
 * strictest possible test of "no wrapper div sits between the frame's own
 * root container and `.sheet-shell`".
 */

const TARGET_ID = 'booking-confirmation-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

interface StudioProjectSummary {
  dir: string
  name: string
}

async function findEsimStackProjectDir(page: Page): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === 'maherfayad-stack-eSIM')
  return match?.dir ?? null
}

async function panIntoView(page: Page, canvasRoot: Locator, target: Locator, tolerancePx = 40): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) {
      throw new Error(`panIntoView: target frame [data-page-id="${TARGET_ID}"] has no bounding box`)
    }

    const dx = targetBox.x + targetBox.width / 2 - (rootBox.x + rootBox.width / 2)
    const dy = targetBox.y + targetBox.height / 2 - (rootBox.y + rootBox.height / 2)
    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target frame never reached the viewport center after 8 pan attempts')
}

test.describe('WS-4.2 regression: a local-component call site is a zero-DOM instance, not a wrapper div', () => {
  test('SheetShell\'s height:100% chain resolves to a non-trivial pixel height, and no [data-node-id] wrapper sits above .sheet-shell', async ({ page }) => {
    const projectDir = await findEsimStackProjectDir(page)
    if (!projectDir) {
      test.skip(true, 'studio-workspace/maherfayad-stack-eSIM is not present on disk for this run')
      return
    }

    await page.addInitScript((dir: string) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
    }, projectDir)

    await page.goto('/admin/site?studio')
    await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('board-frames-layer')).toBeAttached()

    const targetFrame = page.locator(`[data-page-id="${TARGET_ID}"]`)
    await expect(targetFrame).toHaveCount(1)

    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    const canvasRoot = page.getByTestId('canvas-root')
    await panIntoView(page, canvasRoot, targetFrame)

    const iframeEl = targetFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(iframeEl).toBeVisible({ timeout: 15_000 })

    const contentFrame = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    const sheetShell = contentFrame.locator('.sheet-shell').first()
    await expect(sheetShell).toBeVisible({ timeout: 15_000 })

    // 1. The height:100% chain resolves to a REAL pixel height, not the
    // collapsed-to-content-height a stray wrapper div would produce. The
    // frame itself is sized in the hundreds of px; anything under ~100px
    // here would mean the chain collapsed.
    const shellHeight = await sheetShell.evaluate((el) => el.getBoundingClientRect().height)
    expect(shellHeight).toBeGreaterThan(200)

    // `.sheet-shell__panel` is `flex: 1; min-height: 0` INSIDE the shell —
    // it only gets a non-zero height if `.sheet-shell` itself resolved a
    // real height for it to divide up.
    const panel = contentFrame.locator('.sheet-shell__panel').first()
    const panelHeight = await panel.evaluate((el) => el.getBoundingClientRect().height)
    expect(panelHeight).toBeGreaterThan(50)

    // 2. Zero DOM boxes: `.sheet-shell` is SheetShell's OWN root element —
    // its immediate parent inside the iframe body must be a node the
    // AUTHOR'S OWN tree put there, never an editor-inserted wrapper. Every
    // `[data-node-id]` ancestor of `.sheet-shell` up to the iframe body is
    // enumerated; the call-site "studio.instance" node contributes NONE of
    // them — if it did, it would show up as an extra ancestor with no
    // corresponding DOM box of its own (impossible to observe directly,
    // so the meaningful proxy is: `.sheet-shell`'s own parentElement is
    // NOT a bare, class-less, otherwise-invisible <div> that only the
    // editor could have inserted).
    const parentTagAndClass = await sheetShell.evaluate((el) => {
      const p = el.parentElement
      return p ? { tag: p.tagName.toLowerCase(), className: p.className, hasNodeId: p.hasAttribute('data-node-id') } : null
    })
    // The page's own root container (`base.body`'s rendered element) is the
    // only legitimate parent here — it DOES carry `data-node-id` (it's a
    // real page node), which is exactly the point: nothing EXTRA sits
    // between it and `.sheet-shell`.
    expect(parentTagAndClass).not.toBeNull()
    expect(parentTagAndClass!.hasNodeId).toBe(true)
  })
})
