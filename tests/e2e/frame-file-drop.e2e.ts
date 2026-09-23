import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * `sec-17` landmine 6, closed: **the frame drag relay's FILE path had no test
 * at all, in any suite.**
 *
 * `installFrameDragRelay` (`src/admin/pages/site/canvas/canvasFrameDragRelay.ts`)
 * has exactly two branches and they do opposite things:
 *
 *   - **cancel**, unconditionally, first — the browser's default for an
 *     uncancelled drop is to NAVIGATE the document that received it, so a
 *     dropped link turns a design frame into an attacker-chosen page rendered
 *     inside the editor's own chrome, with the portal's React root gone;
 *   - **relay**, for file-carrying drags only — re-dispatch the event on the
 *     iframe ELEMENT in the parent document so it reaches
 *     `useCanvasFileDrop`'s `window` listener and becomes a real `<img>`.
 *
 * The unit suite can only drive the first one. happy-dom implements neither
 * `DragEvent` nor `DataTransfer`, so `src/__tests__/canvas/canvasFrameDragRelay.test.ts`
 * constructs a synthetic event object and asserts `preventDefault` was called —
 * which is the whole of what it can assert. The re-dispatch, the coordinate
 * translation into the parent's client space, the upload, and the source write
 * are all unreachable from there. That is not a gap in that file; it is the
 * reason this one exists.
 *
 * ## Why the drop is built inside the frame, not with `setInputFiles`
 *
 * `page.setInputFiles` drives an `<input type="file">`. There is no input in
 * this gesture: the user drags an image off their desktop onto a frame, and
 * every interesting thing here happens between the frame's document and the
 * parent's `window`. So the drag is built the way a browser builds one — a real
 * `DataTransfer` carrying a real `File`, constructed in the FRAME's realm and
 * dispatched on the frame's own document — and the relay either carries it out
 * to the board or it does not.
 *
 * ## What is asserted, and why each is a refusal
 *
 *   1. the PNG lands in the project's `public/` (the one directory
 *      `assetDrop.ts` will write to) **of the throwaway workspace copy**, and
 *      an `<img src="/…">` appears in the page's real `.tsx`;
 *   2. a `text/uri-list` drop does NOT navigate the frame. That is the
 *      security half: it must be cancelled and NOT relayed, so nothing at all
 *      happens — no navigation, no upload, no source write. A build that
 *      narrowed the cancel back to "files only" passes (1) and fails (2).
 */

/** A 1x1 opaque PNG. Small enough to inline, real enough for the server's sniffer. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const DROPPED_FILE_NAME = 'dropped-photo.png'

const FIXTURE_PAGE = `import './home.css'

export default function Home() {
  return (
    <main className="home">
      <h1 className="home__title">Drop target</h1>
      <p className="home__body">One paragraph, one heading, and room to drop something onto.</p>
    </main>
  )
}
`

const FIXTURE_CSS = `.home {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 40px;
  min-height: 560px;
  font-family: system-ui, sans-serif;
  background: #ffffff;
  color: #111111;
}

.home__title {
  margin: 0;
  font-size: 32px;
}

.home__body {
  margin: 0;
  font-size: 16px;
}
`

let fixture: FixtureProject

const pagePath = (): string => path.join(fixture.dir, 'pages', 'Home.jsx')
const readPage = (): string => fs.readFileSync(pagePath(), 'utf8')
const publicDir = (): string => path.join(fixture.dir, 'public')

test.beforeEach(() => {
  // A pristine copy per case: case 1 writes an `<img>` into the source and a
  // file into `public/`, and case 2's whole claim is that NOTHING changed —
  // which case 1's leftovers would make unfalsifiable.
  //
  // `.jsx`, a `public/` directory and a plain stylesheet: nothing shared with
  // the eSIM corpus, per `genericRepoShapes.test.ts`'s rule that a suite grown
  // from one repository encodes that repository's habits.
  fixture = createAuthoredFixtureProject('__e2e-frame-file-drop', {
    'pages/Home.jsx': FIXTURE_PAGE,
    'pages/home.css': FIXTURE_CSS,
    'public/.gitkeep': '',
    'package.json': JSON.stringify({ name: 'frame-file-drop-fixture', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify(
        {
          displayName: 'Zz Frame File Drop Fixture',
          platform: 'web',
          pagesDir: 'pages',
          frameDefaults: { width: 900, height: 640 },
        },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

/**
 * Dispatch a real `dragover`+`drop` pair INSIDE the frame's document, at the
 * centre of `selector`.
 *
 * Everything here runs in the frame's own realm, which is the point: the relay
 * listens on that document, and a `DataTransfer` built in the parent would not
 * be the thing a browser hands it.
 *
 * `dragover` first and separately, because it is what the relay must cancel for
 * `drop` to be delivered at all — a version that only handled `drop` would pass
 * an assertion written the lazy way and fail in a browser.
 */
async function dropOnFrame(
  frame: ReturnType<Page['frameLocator']>,
  selector: string,
  payload: { kind: 'file'; name: string; base64: string } | { kind: 'uri'; url: string },
): Promise<void> {
  await frame.locator(selector).first().evaluate((element, args) => {
    const rect = element.getBoundingClientRect()
    const transfer = new DataTransfer()
    if (args.kind === 'file') {
      const binary = atob(args.base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      transfer.items.add(new File([bytes], args.name, { type: 'image/png' }))
    } else {
      transfer.setData('text/uri-list', args.url)
      transfer.setData('text/plain', args.url)
    }
    const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    for (const type of ['dragover', 'drop']) {
      element.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: at.x,
          clientY: at.y,
          dataTransfer: transfer,
        }),
      )
    }
  }, payload)
}

/** The mounted design frame, and a frame locator into its document. */
async function firstMountedFrame(page: Page, canvasRoot: Locator) {
  const frameElement = page.locator(`[data-page-id] ${CANVAS_FRAME_IFRAME_SELECTOR}`).first()
  await expect(frameElement, 'no design frame mounted on the fixture board').toBeVisible({ timeout: 60_000 })
  await expect(canvasRoot).toBeVisible()
  return page.locator('[data-page-id]').first().frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
}

test.describe('dragging an image file onto a design frame', () => {
  // A cold ts-morph parse on open, an upload, and a structural write + resync.
  test.setTimeout(240_000)

  test('the file lands in public/ and an <img> is written into the page source', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const contentFrame = await firstMountedFrame(page, canvasRoot)

    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)
    expect(fs.readdirSync(publicDir()).filter((n) => n.endsWith('.png'))).toEqual([])

    await dropOnFrame(contentFrame, '.home__body', {
      kind: 'file',
      name: DROPPED_FILE_NAME,
      base64: PNG_BASE64,
    })

    // Poll both halves rather than sleeping: the upload and the structural
    // commit are two round trips, and a slow machine should read as slow.
    await expect
      .poll(() => fs.readdirSync(publicDir()).filter((name) => name.endsWith('.png')), {
        timeout: 60_000,
        message:
          'nothing was written into the project\'s public/ — either the relay never carried the drop out ' +
          'of the frame, or POST /admin/api/studio/asset-drop refused it',
      })
      .toHaveLength(1)

    const landed = fs.readdirSync(publicDir()).find((name) => name.endsWith('.png'))
    expect(landed, 'no .png in public/').toBeDefined()
    expect(
      fs.statSync(path.join(publicDir(), landed as string)).size,
      'the file that landed in public/ is empty',
    ).toBeGreaterThan(0)

    await expect
      .poll(() => readPage(), {
        timeout: 60_000,
        message:
          'the image reached disk but no <img> reached the source — a drop that uploads and writes nothing ' +
          'is the silent no-op structural writeback exists to prevent',
      })
      .toContain('<img')

    const after = readPage()
    // The `src` is a SITE-ROOT literal, not a `public/` path: `assetSiteUrl.ts`
    // strips the app root's `public/` precisely because that is the segment no
    // framework serves.
    expect(after, 'the <img src> was written as a project path instead of a site-root literal').toMatch(
      /<img[^>]*src="\/[^"]+\.png"/,
    )
    expect(after, 'the <img src> still names public/, which is not a URL any framework serves').not.toContain(
      'src="/public/',
    )
    // An `<img>` with no `alt` is a real accessibility defect written into
    // someone's repository; `altTextFor` seeds it from the file name.
    expect(after, 'the written <img> has no alt text').toMatch(/<img[^>]*alt="/)
    expect(after, 'the alt text did not come from the dropped file name').toContain('alt="dropped-photo"')
    // Everything the page already had is still there, byte for byte.
    expect(after).toContain('<h1 className="home__title">Drop target</h1>')
  })

  test('a dropped link is cancelled, not followed — the frame does not navigate', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const contentFrame = await firstMountedFrame(page, canvasRoot)

    const before = readPage()
    const urlBefore = await contentFrame.locator('body').evaluate(() => window.location.href)

    await dropOnFrame(contentFrame, '.home__body', { kind: 'uri', url: 'https://example.com/attacker' })

    // Give a navigation the same chance to happen that the file drop had to
    // reach disk. Asserting immediately would pass against a frame that is
    // merely still loading the attacker's page.
    await page.waitForTimeout(2_000)

    expect(
      await contentFrame.locator('body').evaluate(() => window.location.href),
      'the frame navigated to the dropped URL — the browser\'s default for an uncancelled drop is to load ' +
        'it, which replaces the user\'s design with an attacker-chosen page inside the editor\'s own chrome',
    ).toBe(urlBefore)
    await expect(
      contentFrame.locator('.home__title'),
      'the frame lost its own document, so something replaced it',
    ).toBeVisible()
    await expect(canvasRoot, 'the board itself navigated').toBeVisible()

    // Cancelled AND not relayed: a link is not a file, so nothing should have
    // been uploaded and nothing should have been written.
    expect(fs.readdirSync(publicDir()).filter((name) => name.endsWith('.png'))).toEqual([])
    expect(readPage(), 'a dropped link changed the user\'s source').toBe(before)
  })
})
