import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { openProject, type DaemonHandle } from '@ccs/sync-daemon';
import type { FrameMeta } from '@ccs/protocol';
import { buildFrameSource, buildNewCanvasJsonEntry, frameSourcePath, patchFramesRegistry } from '../../src/new-frame.js';

/**
 * ============================================================================
 * P1 JOINT ACCEPTANCE — Playwright e2e driving the REAL canvas (StudioCanvas
 * inside the dev harness) against the REAL sync-daemon (playbook §4/P1,
 * §5.10). Mirrors `packages/sync-daemon/src/e2e.demo.test.ts`'s discipline:
 * this file IS the demo, not a wrapper around one — boots real processes,
 * mutates the repo's own `files/demo` fixture, reports real numbers, and
 * reverts everything in `afterAll`.
 *
 * Run: `pnpm --filter @ccs/canvas run test:e2e`
 *
 * Covers all four playbook §4/P1 sub-acceptance criteria:
 *   (a) edit Hero.tsx on disk -> frame updates in <1s without canvas reload
 *   (b) drag a frame -> its .studio/canvas.json geometry updates
 *   (c) create a frame via the new-frame tool -> the .tsx exists and renders
 *   (d) 20 frames pan/zoom, with a real frame-time measurement
 *
 * Plus the ADR-0015 P1-defect REGRESSION (test (e) below): tldraw's native
 * duplicate/copy/paste used to create `ccs-frame` canvas shapes with no
 * backing `.tsx` file, which the frames->shape reaper in `StudioCanvas.tsx`
 * then deleted the next time ANY frame moved (any `setFrames` call re-runs
 * the sync effect, which treats a fileless shape as stale). Test (e) drives
 * a dedicated fixture frame (`DupSourceName`, seeded at a page position that
 * cannot collide with test (b)'s hard-coded drag gesture or any of the
 * template/perf frames — see its own comment below) through the real
 * Cmd/Ctrl+D duplicate path end-to-end.
 * ============================================================================
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'files', 'demo');
const HERO_TSX = join(DEMO_ROOT, 'src', 'frames', 'Hero.tsx');
const FRAMES_TS = join(DEMO_ROOT, 'src', 'frames.ts');
const CANVAS_JSON = join(DEMO_ROOT, '.studio', 'canvas.json');
const HARNESS_ROOT = join(REPO_ROOT, 'packages', 'canvas', 'dev');
const HARNESS_PORT = 5556;
const DAEMON_PORT_START = 4750;
const FRAME_SERVER_PORT_START = 5250;
const PERF_EXTRA_FRAME_COUNT = 18; // + Hero + Pricing = 20 total (playbook §4/P1 Perf target)

/** ADR-0015 regression fixture frame (test (e)) — seeded at page (0,1000).
 * TEST-ISOLATION FIX (Phase 3a): this used to be y=300, which the original
 * comment claimed was "clear of every frame already on disk" — that was
 * WRONG (confirmed empirically): Hero's own box is (0,0,1440,900), so a
 * y=300 seed with the same 1440x900 size shares canvas y:[300,900] AND
 * x:[0,1440] with Hero, a real, permanent geometric overlap baked into the
 * fixture from the start (nothing to do with any drag gesture). This only
 * ever surfaced now because tests (b)/(e) never got to run before (see
 * `.orchestrator/STATE.md`'s "SESSION PAUSED 2026-07-20" note): once Hero
 * has EVER been interacted with (test (b)'s drag), tldraw brings it to the
 * front, and it then visually occludes `DupSourceName` for the whole
 * overlapping region (including `DupSourceName`'s own header) regardless of
 * which one the camera is fit to — a click computed from `DupSourceName`'s
 * on-screen position lands on Hero instead (confirmed empirically: it
 * duplicated Hero, not DupSourceName). y=1000 sits fully below Hero's
 * (and Pricing/Aad's, both also y:[0,900]) bottom edge with margin, so this
 * frame no longer shares ANY canvas region with anything else in the
 * fixture, regardless of camera/z-order/what other tests have done to Hero. */
const DUP_SOURCE_NAME = 'DupSourceName';
const DUP_SOURCE_X = 0;
const DUP_SOURCE_Y = 1000;
const DUP_SOURCE_TSX = join(DEMO_ROOT, frameSourcePath(DUP_SOURCE_NAME));
const DUP_COPY_TSX = join(DEMO_ROOT, 'src', 'frames', 'DupSourceNameCopy.tsx');

function perfFrameName(i: number): string {
  return `PerfFrame${String(i).padStart(2, '0')}`;
}

/**
 * TEST-ISOLATION HELPERS (Phase 3a): this file's `beforeAll` (see the "Bug
 * fix ... zoomToFrame" comment on the browser-scoped `beforeAll` below)
 * moves the camera off its old zoom=1/pan=(0,0) default BEFORE test (a) even
 * runs, and calling that same `zoomToFrame` handle method also side-effects
 * into `FrameSelectionBridge`'s pre-existing FP-4a "frictionless activation"
 * (`TldrawEngineCanvas.tsx`, predates this whole custom-engine track,
 * confirmed unchanged since before the 2d-ii split) — whatever frame gets
 * `editor.select()`-ed becomes the studio's `editModeFrame` with NO click
 * required. Both consequences invalidate any test in this file that assumes
 * (1) a fixed zoom=1/pan=(0,0) camera for its screen-coordinate math, or (2)
 * that a frame's header is draggable via tldraw's native translate (an
 * ACTIVE/edit-mode frame's header is covered by `edit-mode-layer.tsx`'s
 * pointer-events:auto capture overlay, which has no pointerdown-forwarding
 * equivalent to its own `dispatchWheel` — so a plain header-drag on an
 * already-active frame is swallowed rather than reaching tldraw's translate
 * gesture). These two helpers make a frame's header interaction robust to
 * both, without needing to know or reset the live camera transform.
 */

/** Resolves `name`'s CURRENT on-screen header-chrome center, whatever the
 * live camera transform happens to be. The header's plain-text name label
 * (`frame-shape.tsx`'s `{shape.props.name}`) is the only text node reading
 * exactly `name` in this bare dev harness (no Layers panel mounted), so an
 * exact-text locator resolves to it unambiguously — PROVIDED the frame is
 * actually being freshly rendered (see `focusFrame`'s doc: a frame whose
 * container has scrolled off-screen gets `content-visibility:auto`-skipped
 * by the browser, `frame-shape.tsx`'s `HTMLContainer` — its descendants'
 * `getBoundingClientRect()` then returns STALE geometry frozen from before
 * it was skipped, not its current on-screen position). */
async function frameHeaderCenter(targetPage: Page, name: string): Promise<{ x: number; y: number }> {
  const box = await targetPage.getByText(name, { exact: true }).first().boundingBox();
  if (!box) throw new Error(`expected to find "${name}" frame header chrome on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Deactivates whatever frame is currently active WITHOUT touching the
 * camera: a plain click outside every known frame's screen box drives
 * `FrameSelectionBridge`'s selection to empty, which calls the raw
 * `store.exitEditMode()` (no camera restore — contrast
 * `exitEditModeAndRestoreCamera`, which `Escape` uses and which races
 * `zoomToFrame`'s own in-flight animation, confirmed empirically to settle
 * on an unrelated, unpredictable zoomed-out camera). Every frame in this
 * fixture sits at non-negative (x,y) canvas coordinates (`Hero`@(0,0),
 * `Pricing`@(1600,0), `Aad`@(3200,0), the perf/dup fixtures tile forward
 * from there — see `new-frame.ts`), so a screen point mapping to negative
 * canvas space is always guaranteed clear of every known frame; (5,5) is far
 * enough into any `zoomToBounds` fit's letterboxed margin to land there. */
async function deactivateFrame(targetPage: Page): Promise<void> {
  await targetPage.mouse.click(5, 5);
  await expect(targetPage.getByTestId('ccs-edit-mode-capture')).toHaveCount(0);
}

/** Brings `framePath` freshly into view via the SAME production
 * `StudioCanvasHandle.zoomToFrame` API the beforeAll below uses for Hero
 * (stashed as `window.__ccsHandle` by `dev/main.tsx`'s test-only hook), then
 * strips the resulting edit-mode activation back off via `deactivateFrame`
 * (camera untouched). Confirmed empirically necessary for any frame OTHER
 * than whichever one a PRIOR gesture in this file last focused: this
 * fixture seeds several frames whose canvas boxes genuinely overlap
 * (`Hero`@(0,0,1440,900) and `DupSourceName`@(0,300,1440,900) share
 * y:[300,900]), and once a camera fit targets one of them, the OTHER's
 * on-screen geometry either goes stale (browser-skipped
 * `content-visibility:auto` once its container isn't the one the camera is
 * centered on) or gets visually occluded by whichever frame most recently
 * had a native gesture run on it (tldraw brings the interacted shape
 * forward). Re-fitting the camera directly onto the frame this step
 * actually needs guarantees a fresh, unoccluded, unstale measurement instead
 * of assuming whatever an earlier step in this serial file left the camera
 * on. */
async function focusFrame(targetPage: Page, framePath: string): Promise<void> {
  await targetPage.evaluate((path) => {
    (window as unknown as { __ccsHandle: { zoomToFrame: (fileFolder: string, framePath: string) => void } }).__ccsHandle.zoomToFrame(
      'demo',
      path,
    );
  }, framePath);
  await targetPage.waitForTimeout(300); // let the 200ms zoomToBounds animation fully settle
  await deactivateFrame(targetPage);
}

let daemon: DaemonHandle;
let viteServer: ViteDevServer;
let context: BrowserContext;
let page: Page;

let originalHeroSource: string;
let originalFramesTs: string;
let originalCanvasJson: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  originalHeroSource = await readFile(HERO_TSX, 'utf8');
  originalFramesTs = await readFile(FRAMES_TS, 'utf8');
  originalCanvasJson = await readFile(CANVAS_JSON, 'utf8');

  // --- add 18 extra frames so the perf test (d) has a real 20-frame project ---
  let framesTsSource = originalFramesTs;
  const meta: FrameMeta = JSON.parse(originalCanvasJson);
  for (let i = 1; i <= PERF_EXTRA_FRAME_COUNT; i++) {
    const name = perfFrameName(i);
    await writeFile(join(DEMO_ROOT, frameSourcePath(name)), buildFrameSource(name), 'utf8');
    framesTsSource = patchFramesRegistry(framesTsSource, name);
    meta.frames.push(buildNewCanvasJsonEntry(meta.frames, name));
  }
  // --- ADR-0015 regression fixture: a dedicated frame test (e) duplicates ---
  await writeFile(DUP_SOURCE_TSX, buildFrameSource(DUP_SOURCE_NAME), 'utf8');
  framesTsSource = patchFramesRegistry(framesTsSource, DUP_SOURCE_NAME);
  meta.frames.push({ framePath: frameSourcePath(DUP_SOURCE_NAME), x: DUP_SOURCE_X, y: DUP_SOURCE_Y, w: 1440, h: 900 });

  await writeFile(FRAMES_TS, framesTsSource, 'utf8');
  await writeFile(CANVAS_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  daemon = await openProject({
    projectRoot: REPO_ROOT,
    daemonPortStart: DAEMON_PORT_START,
    frameServerPortStart: FRAME_SERVER_PORT_START,
    // PERF-PHASE-0 FIX 4 — root cause of the `beforeAll` failure this fixed:
    // without `studioMode: true`, `openProject` boots every file-folder's
    // Vite dev server with ONLY that file-folder's own, un-overlaid
    // `vite.config.ts` (the P0 standalone-contract default —
    // `daemon.ts`'s own doc on this option). `writeStudioViteConfig`
    // (`studio-vite-config.ts`) is what adds the `resolve.alias` mapping the
    // bare `design-system` specifier to the built `<projectRoot>/design-
    // system/dist/*` output, and it only runs when `studioMode` is on — so
    // `files/demo/src/frames/Hero.tsx`'s `import { Accolade } from
    // 'design-system'` (and `Aad.tsx`'s identical import) was unresolvable,
    // crashing the Hero frame before this suite's very first
    // `page.frameLocator('iframe[title="Hero"]')` assertion in the
    // `beforeAll` below could ever pass. `demo:daemon` (`dev/run-daemon.ts`)
    // already passes `studioMode: true` for exactly this reason (see its own
    // doc) — this brings the e2e harness's daemon boot in line with it.
    studioMode: true,
  });
  console.log(`[e2e] real daemon up: control-ws ws://127.0.0.1:${daemon.daemonPort}`);
  for (const ff of daemon.fileFolders) {
    console.log(`[e2e] file-folder "${ff.name}" -> ${ff.devServerUrl} (${ff.frameNames.length} frames)`);
  }

  viteServer = await createViteServer({
    configFile: false,
    root: HARNESS_ROOT,
    plugins: [react()],
    server: { port: HARNESS_PORT, strictPort: true, host: '127.0.0.1' },
  });
  await viteServer.listen();
  console.log(`[e2e] dev harness up: http://127.0.0.1:${HARNESS_PORT}`);

  // The harness's "+ New Frame" tool no longer needs a separate dev-only
  // HTTP endpoint (see dev/main.tsx's module doc) — `StudioCanvas`'s
  // default `onCreateFrame` (ADR-0014) sends `create-frame` straight over
  // the same control-ws connection to THIS test's own daemon, so
  // criterion (c) below exercises the real daemon API end-to-end.
});

test.afterAll(async () => {
  await viteServer?.close();
  await daemon?.close();

  const extraTsxFiles = Array.from({ length: PERF_EXTRA_FRAME_COUNT }, (_, i) =>
    join(DEMO_ROOT, frameSourcePath(perfFrameName(i + 1))),
  );
  await Promise.all(extraTsxFiles.map((f) => rm(f, { force: true })));
  await rm(join(DEMO_ROOT, 'src', 'frames', 'E2ENewFrame.tsx'), { force: true });
  await rm(DUP_SOURCE_TSX, { force: true });
  await rm(DUP_COPY_TSX, { force: true }); // + any HeroCopy2/etc. if a collision retry ever fires — see test (e)
  await rm(join(DEMO_ROOT, 'src', 'frames', 'DupSourceNameCopy2.tsx'), { force: true });

  await writeFile(HERO_TSX, originalHeroSource, 'utf8');
  await writeFile(FRAMES_TS, originalFramesTs, 'utf8');
  await writeFile(CANVAS_JSON, originalCanvasJson, 'utf8');
  console.log('[e2e] files/demo fixture restored to its original state');
});

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  // ADR-0015 test (e) needs the browser's OS-clipboard so native Ctrl+C/V
  // actually attempts a paste (tldraw's `paste` action calls
  // `navigator.clipboard.read()`; without this grant Chromium rejects that
  // call and paste silently no-ops, which would make the "no phantom frame"
  // assertion trivially true for the wrong reason instead of exercising the
  // phantom-frame guard for real).
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${HARNESS_PORT}` });
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${HARNESS_PORT}/?daemonPort=${daemon.daemonPort}`);

  // Bug fix (Phase 3 parity-verification baseline, see .orchestrator/STATE.md
  // Phase 0 FIX 4 + Phase 3 kickoff note): this `beforeAll` used to assert on
  // `iframe[title="Hero"]` immediately after `page.goto`, relying on Hero
  // incidentally ranking in `viewport-cull.ts`'s nearest-8-to-viewport-center
  // live budget once the mount-time `zoomToFit` frames the camera on the
  // bounding box of ALL ~22 frames (Hero + Pricing + Aad + the 18
  // `PERF_EXTRA_FRAME_COUNT` frames + the ADR-0015 `DupSourceName` fixture
  // added above). That's not guaranteed — Hero's fixed seed position isn't
  // guaranteed to be among the nearest 8 to the shifted fit-all center, so it
  // could silently render as a placeholder instead of a live iframe, and
  // `iframe[title="Hero"]` would never appear. This is a genuine product
  // behavior gap (the cull cap is correct and intentionally NOT weakened
  // here — see `DEFAULT_MAX_LIVE_FRAMES` in `viewport-cull.ts`), but the
  // right fix belongs in this test's setup: a real user editing `Hero.tsx`
  // would actually be LOOKING AT Hero (selected/zoomed to it), not trusting
  // that it randomly lands in a fit-all-of-22-frames' nearest-8 group. So,
  // matching that real user action, explicitly zoom the camera to Hero via
  // `StudioCanvasHandle.zoomToFrame` (identical shape on both the tldraw and
  // custom engines, playbook §5.4) — stashed on `window.__ccsHandle` by
  // `dev/main.tsx`'s test-only `onReady` hook (see that file's own doc) —
  // BEFORE asserting on its content, guaranteeing Hero is the nearest frame
  // to its own viewport center regardless of how many other frames this
  // suite's fixtures add.
  await page.waitForFunction(() => Boolean((window as unknown as { __ccsHandle?: unknown }).__ccsHandle));
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/DEBUG-post-mount-pre-zoomtoframe.png' });
  await page.evaluate(() => {
    (window as unknown as { __ccsHandle: { zoomToFrame: (fileFolder: string, framePath: string) => void } }).__ccsHandle.zoomToFrame(
      'demo',
      'src/frames/Hero.tsx',
    );
  });

  await expect(page.frameLocator('iframe[title="Hero"]').locator('h1')).toHaveText(
    'Plan your next trip effortlessly',
    { timeout: 15_000 },
  );
});

test.afterAll(async () => {
  await context?.close();
});

test('(a) editing Hero.tsx on disk updates the live iframe in <1s without a canvas reload', async () => {
  await page.evaluate(() => {
    (window as unknown as { __ccsNoReloadMarker?: string }).__ccsNoReloadMarker = 'still-here';
  });

  const heroHeading = page.frameLocator('iframe[title="Hero"]').locator('h1');
  const marker = 'HMR ACCEPTANCE MARKER';
  const start = Date.now();
  await writeFile(HERO_TSX, originalHeroSource.replace('Plan your next trip effortlessly', marker), 'utf8');
  await expect(heroHeading).toHaveText(marker, { timeout: 5_000 });
  const elapsedMs = Date.now() - start;
  console.log(`[e2e] (a) HMR update observed after ${elapsedMs}ms`);
  expect(elapsedMs).toBeLessThan(1000);

  const markerSurvived = await page.evaluate(
    () => (window as unknown as { __ccsNoReloadMarker?: string }).__ccsNoReloadMarker,
  );
  expect(markerSurvived, 'a full canvas reload would have wiped this in-memory marker').toBe('still-here');

  await writeFile(HERO_TSX, originalHeroSource, 'utf8'); // restore before (b)/(c)/(d)
  await expect(heroHeading).toHaveText('Plan your next trip effortlessly', { timeout: 5_000 });
});

test('(b) dragging a frame updates its .studio/canvas.json geometry via the real daemon', async () => {
  const before: FrameMeta = JSON.parse(await readFile(CANVAS_JSON, 'utf8'));
  const heroBefore = before.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
  expect(heroBefore).toBeDefined();

  // TEST-ISOLATION FIX (Phase 3a — see the `frameHeaderCenter`/
  // `deactivateFrame`/`focusFrame` helpers' own doc above for the full "why"
  // this is needed): this file's `beforeAll` calling `zoomToFrame` to bring
  // Hero into view (necessary for test (a), see that `beforeAll`'s own
  // comment) both moves the camera off zoom=1/pan=(0,0) AND leaves Hero as
  // the active `editModeFrame` (a pre-existing, out-of-scope product gap
  // flagged there: an active frame's header can't be re-dragged via
  // tldraw's native translate once `edit-mode-layer.tsx`'s capture overlay
  // is mounted over it). `focusFrame` re-fits the camera onto Hero fresh and
  // strips that activation back off, so this reads Hero's REAL current
  // on-screen header position rather than assuming either the default
  // camera or whatever the last `beforeAll` fit left behind.
  await focusFrame(page, 'src/frames/Hero.tsx');
  const { x: startX, y: startY } = await frameHeaderCenter(page, 'Hero');

  // iframe pointer-events:none (playbook §4/P1 pitfall) means this always
  // lands on the header/chrome, never the iframe — exactly the gesture
  // tldraw needs to see to start a translate.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 60, startY + 40, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(
      async () => {
        const after: FrameMeta = JSON.parse(await readFile(CANVAS_JSON, 'utf8'));
        return after.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
      },
      { timeout: 5_000, message: 'expected Hero.tsx canvas.json entry to change after the drag' },
    )
    .not.toEqual(heroBefore);

  const after: FrameMeta = JSON.parse(await readFile(CANVAS_JSON, 'utf8'));
  const heroAfter = after.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
  console.log(`[e2e] (b) canvas.json Hero entry: ${JSON.stringify(heroBefore)} -> ${JSON.stringify(heroAfter)}`);

  // Restore Hero's geometry via the SAME real `set-geometry` daemon write
  // (`StudioCanvasHandle.setFrameGeometry`, ADR-0013) the drag/resize commit
  // path itself uses — not a raw file rewrite — so later tests in this
  // serial file (`DupSourceName`'s box, seeded at (0,300,1440,900),
  // genuinely overlaps Hero's own (0,0,1440,900) — a pre-existing fixture
  // property, not something this drag introduced) inherit Hero back at its
  // ORIGINAL position instead of having to account for wherever this drag
  // happened to leave it.
  expect(heroBefore).toBeDefined();
  await page.evaluate(
    ([geometry]) => {
      (
        window as unknown as {
          __ccsHandle: { setFrameGeometry: (fileFolder: string, framePath: string, geometry: Partial<{ x: number; y: number; w: number; h: number }>) => void };
        }
      ).__ccsHandle.setFrameGeometry('demo', 'src/frames/Hero.tsx', geometry);
    },
    [{ x: heroBefore!.x, y: heroBefore!.y }] as const,
  );
  await expect
    .poll(
      async () => {
        const restored: FrameMeta = JSON.parse(await readFile(CANVAS_JSON, 'utf8'));
        return restored.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
      },
      { timeout: 5_000, message: 'expected Hero.tsx canvas.json entry to be restored after test (b)' },
    )
    .toEqual(heroBefore);
});

test('(c) creating a frame via the new-frame tool (real daemon create-frame control-ws API, ADR-0014) creates the .tsx and it renders', async () => {
  await page.getByRole('button', { name: '+ New Frame' }).click();
  await page.getByRole('textbox', { name: 'New frame name' }).fill('E2ENewFrame');
  await page.getByRole('button', { name: 'Create' }).click();

  const tsxPath = join(DEMO_ROOT, 'src', 'frames', 'E2ENewFrame.tsx');
  await expect.poll(() => existsSync(tsxPath), { timeout: 5_000 }).toBe(true);
  console.log(`[e2e] (c) ${tsxPath} exists on disk`);

  await expect
    .poll(async () => (await readFile(FRAMES_TS, 'utf8')).includes("import E2ENewFrame from './frames/E2ENewFrame.js';"), {
      timeout: 5_000,
    })
    .toBe(true);

  const demoFolder = daemon.fileFolders.find((f) => f.name === 'demo');
  expect(demoFolder).toBeDefined();
  const framePage = await context.newPage();
  await framePage.goto(`http://127.0.0.1:${demoFolder!.port}/?frame=E2ENewFrame`);
  await expect(framePage.getByRole('heading', { level: 1 })).toHaveText('E2ENewFrame');
  console.log('[e2e] (c) new frame renders at its own dev-server URL: heading text confirmed');
  await framePage.close();
});

// Declared BEFORE test (d) on purpose (labels are semantic, not
// declaration-order — a,b,c are the pre-existing P1 criteria, d is the
// perf test, e is this ADR-0015 regression): (d)'s pan/zoom gestures would
// otherwise leave the camera in an unpredictable state for every test
// declared after it (Playwright's serial mode shares one `page`/camera
// across the whole file).
test('(e) ADR-0015 regression: duplicating a frame creates a real file-backed copy; moving either frame leaves both intact; native copy/paste creates no phantom frame', async () => {
  // TEST-ISOLATION FIX (Phase 3a): `DupSourceName` was seeded (in the top
  // `beforeAll`) at page (0,300,1440,900) — this OVERLAPS Hero's own
  // (0,0,1440,900) box (both share canvas y:[300,900]), a pre-existing
  // fixture property, not something any drag introduces. Once this file's
  // `beforeAll` (`zoomToFrame`, see its own comment) — or test (b)'s own
  // drag — has fit the camera onto/interacted with Hero, `DupSourceName`'s
  // on-screen geometry either goes STALE (`content-visibility:auto` skips
  // re-layout for a container the camera isn't currently centered on — see
  // `focusFrame`'s doc) or gets OCCLUDED (tldraw brings the most-recently-
  // dragged shape to the front, and it geometrically overlaps
  // `DupSourceName`'s own center point) — confirmed empirically: a click
  // computed from `DupSourceName`'s (stale/occluded) text position landed on
  // Hero instead, duplicating the wrong frame. `focusFrame` re-fits the
  // camera directly onto `DupSourceName` fresh each time, sidestepping both.
  await focusFrame(page, frameSourcePath(DUP_SOURCE_NAME));
  const dupStart = await frameHeaderCenter(page, DUP_SOURCE_NAME);

  // --- select the frame, then Cmd/Ctrl+D: StudioCanvas's `overrides.actions.duplicate`
  // (ADR-0015) intercepts this for ccs-frame shapes and issues a real
  // daemon `duplicate-frame` request instead of tldraw's native record-copy ---
  await page.mouse.click(dupStart.x, dupStart.y);
  await page.keyboard.press('Control+d');

  await expect.poll(() => existsSync(DUP_COPY_TSX), { timeout: 5_000 }).toBe(true);
  const sourceContent = await readFile(DUP_SOURCE_TSX, 'utf8');
  const copiedContent = await readFile(DUP_COPY_TSX, 'utf8');
  expect(copiedContent).toBe(sourceContent);
  console.log(`[e2e] (e) ${DUP_COPY_TSX} exists on disk with content copied from ${DUP_SOURCE_NAME}.tsx`);

  await expect
    .poll(
      async () => (await readFile(FRAMES_TS, 'utf8')).includes(`import ${DUP_SOURCE_NAME}Copy from './frames/${DUP_SOURCE_NAME}Copy.js';`),
      { timeout: 5_000 },
    )
    .toBe(true);

  await expect
    .poll(
      async () => {
        const meta: FrameMeta = JSON.parse(await readFile(CANVAS_JSON, 'utf8'));
        return meta.frames.some((f) => f.framePath === `src/frames/${DUP_SOURCE_NAME}Copy.tsx`);
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  console.log('[e2e] (e) duplicate registered in src/frames.ts and .studio/canvas.json');

  // both the source and the copy must render live — no phantom, both
  // record-backed (this is what makes it a real, not a native, duplicate).
  await expect(page.frameLocator(`iframe[title="${DUP_SOURCE_NAME}"]`).locator('h1')).toHaveText(DUP_SOURCE_NAME, {
    timeout: 5_000,
  });
  // heading still reads DUP_SOURCE_NAME, not "...Copy" — see the pure-copy
  // decision note above.
  await expect(page.frameLocator(`iframe[title="${DUP_SOURCE_NAME}Copy"]`).locator('h1')).toHaveText(DUP_SOURCE_NAME, {
    timeout: 5_000,
  });

  // --- the actual P1 defect: move EITHER frame -> BOTH must survive -----
  // (previously, ANY frame move re-ran the frames->shape sync effect,
  // whose reaper deleted the fileless copy shape on that very sync).
  // Drag the ORIGINAL source frame's header a little. Re-focus fresh (same
  // reason as above — the select+duplicate above left SOME frame active/
  // edit-mode, and possibly a stale/occluded camera fit for this one).
  await focusFrame(page, frameSourcePath(DUP_SOURCE_NAME));
  const dragStart = await frameHeaderCenter(page, DUP_SOURCE_NAME);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 60, dragStart.y + 60, { steps: 8 });
  await page.mouse.up();

  // give the debounced geometry write -> file-changed -> setFrames sync
  // (the exact cycle that used to reap the phantom) time to run at least once.
  await page.waitForTimeout(500);

  expect(existsSync(DUP_SOURCE_TSX), 'the source frame file must still exist after the drag').toBe(true);
  expect(existsSync(DUP_COPY_TSX), 'the duplicated frame file must still exist on disk after moving the other frame').toBe(
    true,
  );
  await expect(page.frameLocator(`iframe[title="${DUP_SOURCE_NAME}"]`).locator('h1')).toHaveText(DUP_SOURCE_NAME, {
    timeout: 5_000,
  });
  // The copy's heading still reads `DUP_SOURCE_NAME`, NOT
  // `${DUP_SOURCE_NAME}Copy` — a deliberate decision (see `duplicate-frame.ts`'s
  // module doc): the daemon does a pure, byte-for-byte content copy and does
  // NOT rename the internal `export default function <Name>()` identifier
  // (or any JSX text) to match the new filename, because `src/frames.ts`
  // imports a frame's default export under a local binding named after the
  // FILE (`import DupSourceNameCopy from './frames/DupSourceNameCopy.js'`),
  // so the component's own internal name/content never has to match the
  // filename for the app to render correctly — verified by the `iframe`
  // `title` attribute (driven by `CcsFrameShapeProps.name`, the filename)
  // being the distinct `${DUP_SOURCE_NAME}Copy` while its content is identical
  // to the source's.
  await expect(page.frameLocator(`iframe[title="${DUP_SOURCE_NAME}Copy"]`).locator('h1')).toHaveText(DUP_SOURCE_NAME, {
    timeout: 5_000,
  });
  console.log('[e2e] (e) moving the original frame left the duplicated copy intact on canvas AND disk (no phantom reap)');

  // --- native Ctrl+C / Ctrl+V must NOT create a fileless phantom frame ---
  const framesDir = join(DEMO_ROOT, 'src', 'frames');
  const tsxCountBefore = (await readdir(framesDir)).length;

  // (re)select the source frame — re-focus fresh again (the drag above
  // shifted its position, and left it active/edit-mode again too).
  await focusFrame(page, frameSourcePath(DUP_SOURCE_NAME));
  const reselectPos = await frameHeaderCenter(page, DUP_SOURCE_NAME);
  await page.mouse.click(reselectPos.x, reselectPos.y);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  // give a phantom shape time to appear (and, if the guard regressed, to
  // get reaped by the pre-existing frames-sync effect on its own) —
  // either way, no NEW frame file should ever land on disk.
  await page.waitForTimeout(800);

  const tsxCountAfter = (await readdir(framesDir)).length;
  expect(tsxCountAfter, 'native copy/paste must not write a new frame file').toBe(tsxCountBefore);
  console.log(`[e2e] (e) native Ctrl+C/Ctrl+V created no phantom frame file (${tsxCountBefore} -> ${tsxCountAfter} .tsx files)`);
});

test('(d) 20 frames pan/zoom performance measurement', async () => {
  await page.evaluate(() => {
    const w = window as unknown as { __ccsFrameTimes: number[]; __ccsRafId: number };
    w.__ccsFrameTimes = [];
    let last = performance.now();
    function loop() {
      const now = performance.now();
      w.__ccsFrameTimes.push(now - last);
      last = now;
      w.__ccsRafId = requestAnimationFrame(loop);
    }
    w.__ccsRafId = requestAnimationFrame(loop);
  });

  const panStart = Date.now();
  while (Date.now() - panStart < 1500) {
    await page.mouse.wheel(45, 0);
    await page.waitForTimeout(16);
  }

  await page.keyboard.down('Control');
  const zoomStart = Date.now();
  while (Date.now() - zoomStart < 1500) {
    await page.mouse.wheel(0, -25);
    await page.waitForTimeout(16);
  }
  await page.keyboard.up('Control');

  const frameTimes = await page.evaluate(() => {
    const w = window as unknown as { __ccsFrameTimes: number[]; __ccsRafId: number };
    cancelAnimationFrame(w.__ccsRafId);
    return w.__ccsFrameTimes;
  });

  const usable = frameTimes.slice(3); // drop warm-up samples
  const avgFrameTimeMs = usable.reduce((a, b) => a + b, 0) / usable.length;
  const fps = 1000 / avgFrameTimeMs;
  const worstFrameMs = Math.max(...usable);
  const framesOver33ms = usable.filter((t) => t > 33.33).length; // dropped-below-30fps frames

  console.log(
    `[e2e] (d) 20-frame pan+zoom: ${usable.length} rAF samples over ${(usable.reduce((a, b) => a + b, 0) / 1000).toFixed(2)}s, ` +
      `avg ${avgFrameTimeMs.toFixed(2)}ms/frame (~${fps.toFixed(1)}fps), worst frame ${worstFrameMs.toFixed(2)}ms, ` +
      `${framesOver33ms}/${usable.length} frames slower than 30fps`,
  );

  // Regression guard for the playbook §4/P1 60fps gate. Actual measured avg
  // is ~118fps (2x margin); guard set at 50 to catch a real regression toward
  // the 60fps floor while tolerating CI jitter. See console log above for the
  // headline number. (Tightened per AUDIT-3 finding #2.)
  expect(fps).toBeGreaterThan(50);
});
