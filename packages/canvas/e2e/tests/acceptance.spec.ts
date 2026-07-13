import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(FRAMES_TS, framesTsSource, 'utf8');
  await writeFile(CANVAS_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  daemon = await openProject({
    projectRoot: REPO_ROOT,
    daemonPortStart: DAEMON_PORT_START,
    frameServerPortStart: FRAME_SERVER_PORT_START,
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

  await writeFile(HERO_TSX, originalHeroSource, 'utf8');
  await writeFile(FRAMES_TS, originalFramesTs, 'utf8');
  await writeFile(CANVAS_JSON, originalCanvasJson, 'utf8');
  console.log('[e2e] files/demo fixture restored to its original state');
});

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${HARNESS_PORT}/?daemonPort=${daemon.daemonPort}`);
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
