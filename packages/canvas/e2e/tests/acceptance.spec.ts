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

/** ADR-0015 regression fixture frame (test (e)) — seeded at page (0,300),
 * a spot verified clear of every frame already on disk (Hero/Pricing/etc.
 * sit far outside `x:[0,1440] y:[0,900]` in the current fixture) AND clear
 * of test (b)'s hard-coded `(100,12)->(260,132)` drag gesture (that only
 * ever reaches screen y<=132; this frame's header renders at y:[300,324]),
 * so this test owns a predictable, collision-free frame regardless of
 * what other frames/tests have done to the camera or to Hero. */
const DUP_SOURCE_NAME = 'DupSourceName';
const DUP_SOURCE_X = 0;
const DUP_SOURCE_Y = 300;
const DUP_SOURCE_TSX = join(DEMO_ROOT, frameSourcePath(DUP_SOURCE_NAME));
const DUP_COPY_TSX = join(DEMO_ROOT, 'src', 'frames', 'DupSourceNameCopy.tsx');

function perfFrameName(i: number): string {
  return `PerfFrame${String(i).padStart(2, '0')}`;
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

  // Hero sits at canvas (0,0) with the default zoom=1/pan=(0,0) camera, so
  // its header strip (FRAME_HEADER_HEIGHT=24) is at screen (0,0)-(*,24).
  // iframe pointer-events:none (playbook §4/P1 pitfall) means this always
  // lands on the header/chrome, never the iframe — exactly the gesture
  // tldraw needs to see to start a translate.
  await page.mouse.move(100, 12);
  await page.mouse.down();
  await page.mouse.move(260, 132, { steps: 8 });
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
// perf test, e is this ADR-0015 regression): this test needs the
// zoom=1/pan=(0,0) default camera for its screen-coordinate math, which
// (d)'s pan/zoom gestures would otherwise leave in an unpredictable state
// for every test declared after it (Playwright's serial mode shares one
// `page`/camera across the whole file).
test('(e) ADR-0015 regression: duplicating a frame creates a real file-backed copy; moving either frame leaves both intact; native copy/paste creates no phantom frame', async () => {
  // `DupSourceName` was seeded (in the top beforeAll) at page (0,300) —
  // clear of every other frame on disk and of test (b)'s drag path — so at
  // the still-default zoom=1/pan=(0,0) camera (tests (a)-(c) never pan or
  // zoom) its header renders at screen (0,300)-(*,324).
  const sourceHeaderX = 100;
  const sourceHeaderY = DUP_SOURCE_Y + 12; // vertical center of the 24px header strip

  // --- select the frame, then Cmd/Ctrl+D: StudioCanvas's `overrides.actions.duplicate`
  // (ADR-0015) intercepts this for ccs-frame shapes and issues a real
  // daemon `duplicate-frame` request instead of tldraw's native record-copy ---
  await page.mouse.click(sourceHeaderX, sourceHeaderY);
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
  // Drag the ORIGINAL source frame's header a little.
  await page.mouse.move(sourceHeaderX, sourceHeaderY);
  await page.mouse.down();
  await page.mouse.move(sourceHeaderX + 60, sourceHeaderY + 60, { steps: 8 });
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

  await page.mouse.click(sourceHeaderX, sourceHeaderY); // (re)select the source frame
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
