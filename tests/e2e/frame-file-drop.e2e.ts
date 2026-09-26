import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

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
 *      security half: it must be cancelled in the frame. Since P5-B3 (IMG-5)
 *      a link IS relayed to the board, whose intake (`canvasDropIntake.ts`)
 *      refuses a link to a PAGE without a request — so still no navigation,
 *      no upload, no source write. A build that narrowed the cancel back to
 *      "files only" passes (1) and fails (2).
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
          // The relay under test is the DESIGN frame's. Since the Tier-2
          // default (#198) a project starts its own dev server and a live frame
          // mounts beside the design one — two canvas iframes for one page, and
          // a server whose cwd is this directory, which Windows then refuses
          // to delete between cases. Static keeps the spec on the one frame
          // it is about.
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
  const boardFrame = page.locator('[data-page-id]').first()
  await expect(visibleCanvasIframe(boardFrame), 'no design frame mounted on the fixture board').toHaveCount(1, { timeout: 60_000 })
  await expect(canvasRoot).toBeVisible()
  return canvasContentFrame(boardFrame)
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

    // Cancelled in the frame; relayed to the board, which refuses a link to a
    // page (no image path, no dragged <img>) before any request — so nothing
    // should have been fetched, uploaded or written.
    expect(fs.readdirSync(publicDir()).filter((name) => name.endsWith('.png'))).toEqual([])
    expect(readPage(), 'a dropped link changed the user\'s source').toBe(before)
  })
})

/**
 * P5-B (IMG-2, IMG-8, IMG-9) — several images dropped at once.
 *
 * The PNGs are REAL ones, painted on an `OffscreenCanvas` inside the frame's
 * realm at known intrinsic sizes, so the server's header read, the browser's
 * decode and the layout all see a genuine image. Their bytes come back out so
 * the files that land in `public/` can be compared byte for byte.
 */
interface GeneratedImage {
  name: string
  width: number
  height: number
  colour: string
}

async function dropGeneratedImages(
  frame: ReturnType<Page['frameLocator']>,
  selector: string,
  images: readonly GeneratedImage[],
): Promise<string[]> {
  return frame.locator(selector).first().evaluate(async (element, specs) => {
    const transfer = new DataTransfer()
    const encoded: string[] = []
    for (const spec of specs) {
      const canvas = new OffscreenCanvas(spec.width, spec.height)
      const context = canvas.getContext('2d')!
      context.fillStyle = spec.colour
      context.fillRect(0, 0, spec.width, spec.height)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      encoded.push(btoa(binary))
      transfer.items.add(new File([bytes], spec.name, { type: 'image/png' }))
    }
    const rect = element.getBoundingClientRect()
    const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    for (const type of ['dragover', 'drop']) {
      element.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, dataTransfer: transfer }),
      )
    }
    return encoded
  }, images)
}

/**
 * P5-B2 — the image must LOAD, not just take up space.
 *
 * A design frame is an `about:srcdoc` document on the ADMIN origin, so the
 * `src="/x.png"` a drop writes (a site-root URL into the project's `public/`)
 * used to load from Studio's own server, which has nothing there. The box was
 * right — the `<img>` carries `width`/`height` — so every size assertion above
 * passed while the picture itself was broken. `naturalWidth` is what tells a
 * decoded image from a broken one; it is 0 for the latter.
 */
async function loadedNaturalWidth(image: Locator): Promise<number> {
  return image.evaluate((element) => {
    const img = element as HTMLImageElement
    return img.complete ? img.naturalWidth : -1
  })
}

test.describe('an image in public/ loads in a design frame (P5-B2)', () => {
  test.setTimeout(240_000)

  test('a dropped PNG decodes in the design frame, and the source still says the site-root URL', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const contentFrame = await firstMountedFrame(page, canvasRoot)

    await dropGeneratedImages(contentFrame, '.home__body', [{ name: 'loaded.png', width: 48, height: 32, colour: '#c60' }])
    await expect
      .poll(() => readPage(), { timeout: 60_000, message: 'the dropped image never reached the source' })
      .toContain('<img src="/loaded.png"')

    const image = contentFrame.locator('img[src*="loaded.png"]')
    await expect(image).toHaveCount(1, { timeout: 60_000 })
    await expect
      .poll(() => loadedNaturalWidth(image), {
        timeout: 30_000,
        message:
          'the dropped image is in the frame but did not decode: its site-root src resolved against the admin ' +
          'origin instead of the project (naturalWidth 0 = broken image)',
      })
      .toBe(48)
    // The store and the source keep the site-root URL; only the frame's
    // DOM asks the asset route for it.
    expect(readPage()).toContain('<img src="/loaded.png"')
  })

  test('an <img src="/…"> already in the source loads too, and so does a url() in the page CSS', async ({ page }) => {
    fs.writeFileSync(path.join(publicDir(), 'existing.png'), Buffer.from(PNG_BASE64, 'base64'))
    fs.writeFileSync(
      pagePath(),
      FIXTURE_PAGE.replace(
        '<h1 className="home__title">Drop target</h1>',
        '<h1 className="home__title">Drop target</h1>\n      <img src="/existing.png" alt="existing" />\n      <div className="home__banner" />',
      ),
    )
    fs.writeFileSync(
      path.join(fixture.dir, 'pages', 'home.css'),
      `${FIXTURE_CSS}\n.home__banner {\n  width: 10px;\n  height: 10px;\n  background-image: url('/existing.png');\n}\n`,
    )

    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const contentFrame = await firstMountedFrame(page, canvasRoot)

    const image = contentFrame.locator('img[src*="existing.png"]')
    await expect(image).toHaveCount(1, { timeout: 60_000 })
    await expect
      .poll(() => loadedNaturalWidth(image), { timeout: 30_000, message: 'a literal public/ image is broken in the design frame' })
      .toBe(1)

    // The stylesheet's url() goes to the same route; load what the COMPUTED
    // style points at and check it decodes.
    const banner = contentFrame.locator('.home__banner')
    await expect(banner).toHaveCount(1, { timeout: 60_000 })
    const bannerWidth = await banner.evaluate(async (element) => {
      const match = /url\("?([^")]+)"?\)/.exec(getComputedStyle(element).backgroundImage)
      if (!match) return -1
      const probe = new Image()
      probe.src = match[1]!
      try {
        await probe.decode()
      } catch {
        return 0
      }
      return probe.naturalWidth
    })
    expect(bannerWidth, "the page CSS's url('/existing.png') did not load in the design frame").toBe(1)
  })
})

test.describe('dragging several image files onto a design frame (P5-B)', () => {
  test.setTimeout(300_000)

  test('three images are ONE write: exact bytes in public/, sizes clamped to the frame, and one undo removes all three', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const contentFrame = await firstMountedFrame(page, canvasRoot)
    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)

    // The frame is 900 px wide and `.home` has 40 px padding, so the content
    // box is 820 px: the first and third images must be clamped to it, the
    // second fits as it is.
    const images: GeneratedImage[] = [
      { name: 'wide.png', width: 2000, height: 1000, colour: '#d33' },
      { name: 'small.png', width: 400, height: 300, colour: '#3a3' },
      { name: 'tall.png', width: 1640, height: 2460, colour: '#33d' },
    ]
    const sent = await dropGeneratedImages(contentFrame, '.home__body', images)

    await expect
      .poll(() => fs.readdirSync(publicDir()).filter((name) => name.endsWith('.png')).sort(), {
        timeout: 60_000,
        message: 'the three dropped images did not all land in public/',
      })
      .toEqual(['small.png', 'tall.png', 'wide.png'])
    images.forEach((image, i) => {
      expect(
        fs.readFileSync(path.join(publicDir(), image.name)).equals(Buffer.from(sent[i]!, 'base64')),
        `public/${image.name} is not byte-for-byte the file that was dropped`,
      ).toBe(true)
    })

    await expect
      .poll(() => (readPage().match(/<img /g) ?? []).length, {
        timeout: 60_000,
        message: 'the three images did not reach the source',
      })
      .toBe(3)
    const written = readPage()
    // ONE splice: three consecutive siblings, in drop order, each with its
    // intrinsic size clamped to the 820 px content box.
    expect(written).toMatch(
      /<img src="\/wide\.png" alt="wide" width=\{820\} height=\{410\} \/>\n\s*<img src="\/small\.png" alt="small" width=\{400\} height=\{300\} \/>\n\s*<img src="\/tall\.png" alt="tall" width=\{820\} height=\{1230\} \/>/,
    )

    // The computed layout agrees: the rendered boxes are the clamped sizes.
    const rendered = contentFrame.locator('img[src$=".png"]')
    await expect(rendered).toHaveCount(3, { timeout: 60_000 })
    const boxes = await rendered.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return { width: Math.round(rect.width), height: Math.round(rect.height), uploading: element.hasAttribute('data-studio-uploading') }
      }),
    )
    expect(boxes).toEqual([
      { width: 820, height: 410, uploading: false },
      { width: 400, height: 300, uploading: false },
      { width: 820, height: 1230, uploading: false },
    ])

    // One ⌘Z takes all three out of the source, byte for byte.
    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect
      .poll(() => readPage(), { timeout: 60_000, message: 'one undo did not remove all three images' })
      .toBe(FIXTURE_PAGE)
    // Undo never deletes the user's files: redo needs them.
    expect(fs.readdirSync(publicDir()).filter((name) => name.endsWith('.png')).sort()).toEqual([
      'small.png',
      'tall.png',
      'wide.png',
    ])
  })
})
