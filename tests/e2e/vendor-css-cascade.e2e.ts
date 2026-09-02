import { expect, test } from '@playwright/test'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER, VENDOR_LAYER } from '../../src/admin/pages/site/canvas/canvasCssLayers'

/**
 * canvas-03 / WS-2.3 — the one thing happy-dom cannot verify: does a real
 * browser actually resolve the `@layer vendor, user-authored;`
 * pre-declaration (`CANVAS_CSS_LAYER_ORDER`, from the real
 * `canvasCssLayers.ts` source, not a hand-copied string) to rank
 * `user-authored` ABOVE `vendor` in the computed cascade — beating a vendor
 * selector even when that selector is far more specific than the
 * user-authored one.
 *
 * This does not drive the full Studio canvas/editor UI (no project import, no
 * properties-panel interaction) — it reconstructs, byte for byte using the
 * SAME constants `ProjectCssInjector`/`ClassStyleInjector` import, the exact
 * `<style>` tag shapes those two injectors produce, and loads them into a
 * real Chromium page via `page.setContent`. That is deliberately scoped:
 * the question under test is a CSS-engine question (cascade-layer
 * precedence), not an app-integration question, and happy-dom's blindness is
 * specifically to layer precedence — see this suite's own differential
 * check below, which proves the assertion is meaningful by reproducing the
 * OLD (unlayered) bug and confirming it fails the same assertion.
 *
 * No login, no baseURL navigation — `page.setContent` needs neither. Runs in
 * the `e2e` project like any other spec so it shares Playwright's install and
 * config; it just doesn't spend any of that project's browser session on the
 * app itself.
 */

function iframeHtml(vendorStyleTag: string, userStyleTag: string): string {
  return `<!doctype html>
<html>
<head>
${vendorStyleTag}
${userStyleTag}
</head>
<body>
  <div class="page-shell">
    <button id="target" class="btn" data-testid="target">Test</button>
  </div>
</body>
</html>`
}

// A vendor selector that is FAR more specific than the user-authored one
// (id + attribute + class, vs. a bare class) — if layer order didn't beat
// specificity, this vendor rule would win regardless of declaration order.
const VENDOR_CSS = '#target.btn[data-testid="target"] { color: rgb(255, 0, 0); background-color: rgb(255, 0, 0); }'
const USER_CSS = '.btn { color: rgb(0, 0, 255); background-color: rgb(0, 0, 255); }'

test.describe('WS-2.3 vendor/user-authored cascade order', () => {
  test('a user-authored declaration wins over a MORE SPECIFIC vendor declaration, via cascade-layer order', async ({ page }) => {
    const vendorStyleTag = `<style id="mc-vendor">${CANVAS_CSS_LAYER_ORDER}\n@layer ${VENDOR_LAYER} {\n${VENDOR_CSS}\n}</style>`
    const userStyleTag = `<style id="mc-classes">${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${USER_CSS}\n}</style>`

    await page.setContent(iframeHtml(vendorStyleTag, userStyleTag))

    const color = await page.locator('#target').evaluate((el) => getComputedStyle(el).color)
    expect(color).toBe('rgb(0, 0, 255)') // user-authored blue, NOT vendor red
  })

  test('order of the two <style> tags in the document does not matter — the pre-declaration fixes it either way', async ({ page }) => {
    const vendorStyleTag = `<style id="mc-vendor">${CANVAS_CSS_LAYER_ORDER}\n@layer ${VENDOR_LAYER} {\n${VENDOR_CSS}\n}</style>`
    const userStyleTag = `<style id="mc-classes">${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${USER_CSS}\n}</style>`

    // user-authored tag physically FIRST in <head> this time.
    await page.setContent(iframeHtml(userStyleTag, vendorStyleTag))

    const color = await page.locator('#target').evaluate((el) => getComputedStyle(el).color)
    expect(color).toBe('rgb(0, 0, 255)')
  })

  test('DIFFERENTIAL CHECK — the unlayered approach the old AlmDesignSystemCssInjector used gets this backwards', async ({ page }) => {
    // Reproduces the bug this work order fixed: vendor CSS injected UNLAYERED
    // (no @layer at all) while user CSS is @layer user-authored. Unlayered
    // ALWAYS beats @layer'd, regardless of specificity or source order — so
    // vendor wins here, proving the assertion above is actually meaningful
    // and not a tautology that would pass no matter what.
    const unlayeredVendorStyleTag = `<style id="mc-vendor-unlayered">${VENDOR_CSS}</style>`
    const userStyleTag = `<style id="mc-classes">@layer ${USER_AUTHORED_LAYER} {\n${USER_CSS}\n}</style>`

    await page.setContent(iframeHtml(unlayeredVendorStyleTag, userStyleTag))

    const color = await page.locator('#target').evaluate((el) => getComputedStyle(el).color)
    expect(color).toBe('rgb(255, 0, 0)') // vendor red WINS — this is the bug, reproduced on purpose
  })
})
