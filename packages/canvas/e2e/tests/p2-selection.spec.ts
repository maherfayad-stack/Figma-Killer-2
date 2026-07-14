import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type BrowserContext, type Locator } from '@playwright/test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { openProject, type DaemonHandle } from '@ccs/sync-daemon';
import type { FrameMeta, NodeUid } from '@ccs/protocol';
import { frameSourcePath, patchFramesRegistry } from '../../src/new-frame.js';

/**
 * ============================================================================
 * P2/WS-B ACCEPTANCE — Playwright e2e driving the REAL canvas (StudioCanvas
 * inside the dev harness) against the REAL sync-daemon booted with
 * `studioMode: true` (playbook §4/P2, ADR-0016 — WITHOUT this flag the
 * daemon never injects `vite-plugin-source-uid`/`@ccs/bridge`, so there are
 * no `data-uid` attrs and no bridge to hit-test against at all; see
 * `daemon.ts`'s `OpenProjectOptions.studioMode` doc). Same discipline as
 * `acceptance.spec.ts` (this file IS the demo, not a wrapper around one) —
 * boots real processes against the repo's own `files/demo` fixture, and
 * runs in its OWN daemon/harness/browser context on distinct ports so it
 * can run independently of (before, after, or never alongside — Playwright
 * serializes test FILES too under this project's `workers: 1` config) the
 * P1 `acceptance.spec.ts` file.
 *
 * Two ephemeral fixture frames are added in `beforeAll` and removed in
 * `afterAll` (same pattern as `acceptance.spec.ts`'s `PerfFrame*`/
 * `DupSourceName` fixtures) — placed far to the right of every frame
 * already on disk (`files/demo`'s existing frames span roughly
 * x:[-135,6658]) so they never visually overlap anything else in the same
 * project, then panned into view with the mouse wheel per test (playbook
 * §4/P0 BOUNDARIES: fixtures belong in the e2e/dev area, never in
 * `templates/`).
 *
 * Run: `pnpm --filter @ccs/canvas run test:e2e`
 * ============================================================================
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'files', 'demo');
const FRAMES_TS = join(DEMO_ROOT, 'src', 'frames.ts');
const CANVAS_JSON = join(DEMO_ROOT, '.studio', 'canvas.json');
const HARNESS_ROOT = join(REPO_ROOT, 'packages', 'canvas', 'dev');
const HARNESS_PORT = 5557;
const DAEMON_PORT_START = 4850;
const FRAME_SERVER_PORT_START = 5350;

const SELECTION_FIXTURE_NAME = 'SelectionFixture';
const SELECTION_FIXTURE_TSX = join(DEMO_ROOT, frameSourcePath(SELECTION_FIXTURE_NAME));
const SELECTION_FIXTURE_X = 7200;
// Y=200 (not 0): the frame header renders at local y:[0,24], so at page
// y=0 it sits flush against the very top edge of the viewport at the
// default camera — `panUntilOnScreen`'s vertical margin check can never be
// satisfied there since panning below only moves the camera horizontally.
const SELECTION_FIXTURE_Y = 200;

const MAP_LIST_FRAME_NAME = 'MapListFrame';
const MAP_LIST_FRAME_TSX = join(DEMO_ROOT, frameSourcePath(MAP_LIST_FRAME_NAME));
const MAP_LIST_FRAME_X = SELECTION_FIXTURE_X + 1440 + 160;
const MAP_LIST_FRAME_Y = 200;

function buildSelectionFixtureSource(headingText: string): string {
  return `export default function ${SELECTION_FIXTURE_NAME}() {
  return (
    <section className="p-16">
      <h1 className="fixture-heading">${headingText}</h1>
      <p className="fixture-body">Static paragraph, not inside any map/conditional.</p>
    </section>
  );
}
`;
}

function buildMapListFrameSource(): string {
  return `const ITEMS = ['Alpha', 'Beta', 'Gamma'];

export default function ${MAP_LIST_FRAME_NAME}() {
  return (
    <section className="p-16">
      <h1 className="fixture-heading">Map List</h1>
      <ul className="fixture-list">
        {ITEMS.map((item) => (
          <li key={item} className="fixture-list-item">{item}</li>
        ))}
      </ul>
    </section>
  );
}
`;
}

let daemon: DaemonHandle;
let viteServer: ViteDevServer;
let context: BrowserContext;
let page: Page;

let originalFramesTs: string;
let originalCanvasJson: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  originalFramesTs = await readFile(FRAMES_TS, 'utf8');
  originalCanvasJson = await readFile(CANVAS_JSON, 'utf8');

  await writeFile(SELECTION_FIXTURE_TSX, buildSelectionFixtureSource('Hello Fixture'), 'utf8');
  await writeFile(MAP_LIST_FRAME_TSX, buildMapListFrameSource(), 'utf8');

  let framesTsSource = originalFramesTs;
  framesTsSource = patchFramesRegistry(framesTsSource, SELECTION_FIXTURE_NAME);
  framesTsSource = patchFramesRegistry(framesTsSource, MAP_LIST_FRAME_NAME);
  await writeFile(FRAMES_TS, framesTsSource, 'utf8');

  const meta: FrameMeta = JSON.parse(originalCanvasJson);
  meta.frames.push({ framePath: frameSourcePath(SELECTION_FIXTURE_NAME), x: SELECTION_FIXTURE_X, y: SELECTION_FIXTURE_Y, w: 1440, h: 900 });
  meta.frames.push({ framePath: frameSourcePath(MAP_LIST_FRAME_NAME), x: MAP_LIST_FRAME_X, y: MAP_LIST_FRAME_Y, w: 1440, h: 900 });
  await writeFile(CANVAS_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // studioMode: true (ADR-0016 addendum / P2 WS-A daemon boot hook) — the
  // ONLY thing that makes this project's per-file-folder Vite servers
  // inject `vite-plugin-source-uid` + `@ccs/bridge`. Without it every
  // assertion below would find zero `data-uid` attrs and no bridge to
  // hit-test against.
  daemon = await openProject({
    projectRoot: REPO_ROOT,
    daemonPortStart: DAEMON_PORT_START,
    frameServerPortStart: FRAME_SERVER_PORT_START,
    studioMode: true,
  });
  console.log(`[e2e/p2] real daemon (studioMode) up: control-ws ws://127.0.0.1:${daemon.daemonPort}`);

  viteServer = await createViteServer({
    configFile: false,
    root: HARNESS_ROOT,
    plugins: [react()],
    server: { port: HARNESS_PORT, strictPort: true, host: '127.0.0.1' },
  });
  await viteServer.listen();
  console.log(`[e2e/p2] dev harness up: http://127.0.0.1:${HARNESS_PORT}`);
});

test.afterAll(async () => {
  await viteServer?.close();
  await daemon?.close();

  await rm(SELECTION_FIXTURE_TSX, { force: true });
  await rm(MAP_LIST_FRAME_TSX, { force: true });
  await writeFile(FRAMES_TS, originalFramesTs, 'utf8');
  await writeFile(CANVAS_JSON, originalCanvasJson, 'utf8');
  console.log('[e2e/p2] files/demo fixture restored to its original state');
});

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${HARNESS_PORT}/?daemonPort=${daemon.daemonPort}`);
  await expect(page.getByText(SELECTION_FIXTURE_NAME, { exact: true })).toBeAttached({ timeout: 15_000 });
});

test.afterAll(async () => {
  await context?.close();
});

/** Pans the tldraw canvas horizontally (mouse wheel, no modifier = pan —
 * same P1-established gesture as `acceptance.spec.ts` test (d)) until
 * `locator`'s current on-screen bounding box is fully within the viewport.
 * Avoids hard-coding an exact pan distance/multiplier — converges by
 * polling the REAL rendered position instead, so it's robust to whatever
 * tldraw's wheel-to-pan speed actually is. */
async function panUntilOnScreen(target: Page, locator: Locator): Promise<void> {
  const viewport = target.viewportSize() ?? { width: 1280, height: 720 };
  for (let i = 0; i < 80; i++) {
    const box = await locator.boundingBox();
    // Check the CENTER point, not the full box — `frame-shape.tsx`'s
    // header div stretches to the frame's full width (1440, wider than the
    // default viewport) via flexbox `align-items:stretch`, so requiring
    // the WHOLE element on-screen can never be satisfied; a `.dblclick()`
    // (used below) targets the element's center regardless.
    if (box) {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      if (centerX >= 20 && centerX <= viewport.width - 20 && centerY >= 20 && centerY <= viewport.height - 20) {
        return;
      }
    }
    const dx = box ? Math.sign(box.x + box.width / 2 - viewport.width / 2) * 300 || 300 : 300;
    await target.mouse.wheel(dx, 0);
    await target.waitForTimeout(16);
  }
  throw new Error('panUntilOnScreen: target never entered the viewport');
}

/** Raw-coordinate double-click at a locator's center (NOT
 * `Locator.dblclick()`): tldraw renders a full-canvas `.tl-background`
 * layer on top of every shape's own DOM (it does its own internal
 * spatial hit-testing rather than relying on the DOM target under the
 * cursor), which Playwright's locator actionability check correctly
 * refuses to click through even though tldraw itself routes the raw
 * browser event to the right shape regardless of DOM target — the same
 * reason `acceptance.spec.ts` drives frame drags via `page.mouse`, not
 * locator clicks. */
async function dblclickCenter(target: Page, locator: Locator): Promise<void> {
  const box = await pageBoundingBox(target, locator);
  await target.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * `Locator.boundingBox()` already returns coordinates relative to the
 * top-level page/browser viewport EVEN for a locator obtained via
 * `page.frameLocator(...)` (verified empirically against this exact
 * harness: a `.fixture-heading` locator's box was consistent with the
 * containing `iframe[title=...]` element's OWN on-screen box + its CSS
 * padding, at the SAME zoomed-down scale — Playwright composes nested
 * frame/CSS-transform geometry for you). `iframeTitle` is accepted but
 * unused — kept as a marker at call sites for which locators are iframe
 * content (documentation value: if a future Playwright version changes
 * this behavior, every call site needing translation is already tagged). */
async function pageBoundingBox(
  target: Page,
  locator: Locator,
  _iframeTitle?: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  void target;
  const box = await locator.boundingBox();
  if (!box) throw new Error('pageBoundingBox: locator has no bounding box');
  return box;
}

async function hoverCenter(target: Page, locator: Locator, iframeTitle?: string): Promise<void> {
  const box = await pageBoundingBox(target, locator, iframeTitle);
  await target.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

async function clickCenter(target: Page, locator: Locator, iframeTitle?: string): Promise<void> {
  const box = await pageBoundingBox(target, locator, iframeTitle);
  await target.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Pans a frame's header into view, double-clicks it to enter edit mode,
 * and waits out `CcsFrameShapeUtil.onDoubleClick`'s `zoomToBounds`
 * animation (`{animation:{duration:200}}` in `frame-shape.tsx`) before
 * returning. Skipping this wait is a real race: hovering/clicking while
 * the camera is still animating measures content at one (stale) camera
 * tick via Playwright's `boundingBox()` and then hit-tests it at a LATER
 * (different) camera tick once the mouse event actually fires, landing on
 * the wrong node — caught empirically while writing this spec. */
async function enterEditModeByHeader(target: Page, frameName: string): Promise<void> {
  const header = target.getByText(frameName, { exact: true });
  await panUntilOnScreen(target, header);
  await dblclickCenter(target, header);
  await expect(target.getByTestId('ccs-edit-mode-capture')).toBeVisible({ timeout: 5_000 });
  await target.waitForTimeout(350);
}

/** Esc-exits edit mode and waits out `exitEditModeAndRestoreCamera`'s
 * `editor.setCamera(..., {animation:{duration:200}})` restore (same race
 * as `enterEditModeByHeader`'s entry-side wait, just on the way out) —
 * without this, the NEXT test's `panUntilOnScreen` can start measuring a
 * still-animating (and, after a zoom-heavy test, wildly different) camera
 * and never converge. */
async function exitEditMode(target: Page): Promise<void> {
  await target.keyboard.press('Escape');
  await expect(target.getByTestId('ccs-edit-mode-capture')).toHaveCount(0);
  await target.waitForTimeout(300);
}

test('(f)/(g) double-click enters edit mode; hover shows a blue outline + name tag on the correct node; click selects it with the correct breadcrumb', async () => {
  await enterEditModeByHeader(page, SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-breadcrumb-bar')).toBeVisible();

  const frame = page.frameLocator(`iframe[title="${SELECTION_FIXTURE_NAME}"]`);
  const heading = frame.locator('.fixture-heading');
  await expect(heading).toHaveText('Hello Fixture');

  await hoverCenter(page, heading, SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-hover-outline')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('ccs-hover-name-tag')).toHaveText('h1');

  const hoverOutlineBox = await page.getByTestId('ccs-hover-outline').boundingBox();
  const headingBox = await pageBoundingBox(page, heading, SELECTION_FIXTURE_NAME);
  expect(hoverOutlineBox).not.toBeNull();
  // The outline should closely track the actual element (small tolerance
  // for the 2px border box-sizing).
  expect(Math.abs(hoverOutlineBox!.x - headingBox.x)).toBeLessThan(5);
  expect(Math.abs(hoverOutlineBox!.width - headingBox.width)).toBeLessThan(5);

  await clickCenter(page, heading, SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-selection-outline')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('ccs-breadcrumb-bar')).toContainText('section / h1');

  // No dynamic lock badge on a plain static element.
  await expect(page.getByTestId('ccs-lock-badge')).toHaveCount(0);
});

test('(h) selection persists across a non-structural HMR edit (same AST shape, different text)', async () => {
  const frame = page.frameLocator(`iframe[title="${SELECTION_FIXTURE_NAME}"]`);
  const paragraph = frame.locator('.fixture-body');

  await clickCenter(page, paragraph, SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-breadcrumb-bar')).toContainText('section / p', { timeout: 5_000 });
  const uidBefore = await paragraph.getAttribute('data-uid');
  expect(uidBefore).toBeTruthy();

  // Non-structural edit: only the sibling <h1>'s TEXT changes — no JSX
  // element added/removed/reordered, so astPath (and therefore data-uid)
  // for BOTH the h1 and the still-selected <p> is unchanged (ADR-0016/
  // ADR-0017 Decision 3: astPath is whitespace/format/comment invariant;
  // it's derived from JSX nesting position, not text content).
  await writeFile(SELECTION_FIXTURE_TSX, buildSelectionFixtureSource('Hello Fixture (edited)'), 'utf8');
  await expect(frame.locator('.fixture-heading')).toHaveText('Hello Fixture (edited)', { timeout: 5_000 });

  // The selection (and its uid) must have survived the HMR untouched.
  await expect(page.getByTestId('ccs-breadcrumb-bar')).toContainText('section / p');
  const uidAfter = await paragraph.getAttribute('data-uid');
  expect(uidAfter).toBe(uidBefore);
  await expect(page.getByTestId('ccs-selection-outline')).toBeVisible();

  await writeFile(SELECTION_FIXTURE_TSX, buildSelectionFixtureSource('Hello Fixture'), 'utf8');
  await expect(frame.locator('.fixture-heading')).toHaveText('Hello Fixture', { timeout: 5_000 });
});

test('(i) a synthetic uid-remap DaemonEvent is handled without crashing; an unresolvable remap marks the selection detached', async () => {
  const frame = page.frameLocator(`iframe[title="${SELECTION_FIXTURE_NAME}"]`);
  const paragraph = frame.locator('.fixture-body');
  const oldUid = await paragraph.getAttribute('data-uid');
  expect(oldUid).toBeTruthy();

  // No P3 AST engine exists yet to produce a REAL uid-remap on a structural
  // edit (playbook §4/P2 boundary — see worker report) — this synthesizes
  // the FROZEN DaemonEvent shape directly via the daemon's own broadcast
  // API to prove the P2 consumer wires it up end-to-end: a target that
  // genuinely can't be found afterward (bogus new uid, nothing on disk
  // matches it) must be marked detached, not crash the page.
  const fakeNewUid: NodeUid = `${SELECTION_FIXTURE_NAME.toLowerCase()}-does-not-exist.tsx:d99`;
  daemon.broadcast({
    t: 'uid-remap',
    file: frameSourcePath(SELECTION_FIXTURE_NAME),
    map: { [oldUid as NodeUid]: fakeNewUid },
  });

  await expect(page.getByTestId('ccs-breadcrumb-bar')).toContainText('detached', { timeout: 5_000 });
  // The page must still be responsive — re-hover something to prove no
  // uncaught exception tore down the React tree.
  await hoverCenter(page, frame.locator('.fixture-heading'), SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-hover-outline')).toBeVisible({ timeout: 5_000 });

  // Exit edit mode (Esc) so the next test starts clean.
  await exitEditMode(page);
});

test('(j) a `.map()`-generated list item shows the dynamic lock badge and no edit affordance', async () => {
  await enterEditModeByHeader(page, MAP_LIST_FRAME_NAME);

  const frame = page.frameLocator(`iframe[title="${MAP_LIST_FRAME_NAME}"]`);
  const firstItem = frame.locator('.fixture-list-item').first();
  await expect(firstItem).toHaveAttribute('data-dynamic', 'true');

  await hoverCenter(page, firstItem, MAP_LIST_FRAME_NAME);
  await expect(page.getByTestId('ccs-hover-outline')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('ccs-lock-badge').first()).toBeVisible();

  await clickCenter(page, firstItem, MAP_LIST_FRAME_NAME);
  await expect(page.getByTestId('ccs-selection-outline')).toBeVisible({ timeout: 5_000 });
  // Both the (still-live) hover badge and the new selection badge render
  // at once here — the mouse never moved away after the click, so hover
  // state is still current, same as it would be for a static node.
  await expect(page.getByTestId('ccs-lock-badge').first()).toBeVisible();
  await expect(page.getByTestId('ccs-breadcrumb-bar')).toContainText('dynamic');
  // No edit affordance exists anywhere in P2 (editing is P3 scope) — the
  // overlay layer itself (breadcrumb bar + badges) must not have grown any
  // input/button/contenteditable element for a dynamic selection (scoped
  // to the overlay's own testid, not the whole page: tldraw's own chrome
  // keeps an offscreen `<input>` for IME/keyboard handling that has
  // nothing to do with this feature).
  await expect(page.getByTestId('ccs-breadcrumb-bar').locator('input, textarea, button, [contenteditable="true"]')).toHaveCount(0);

  await exitEditMode(page);
});

test('(k) the overlay is positioned correctly at two different zoom levels', async () => {
  await enterEditModeByHeader(page, SELECTION_FIXTURE_NAME);

  const frame = page.frameLocator(`iframe[title="${SELECTION_FIXTURE_NAME}"]`);
  const heading = frame.locator('.fixture-heading');

  await hoverCenter(page, heading, SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-hover-outline')).toBeVisible({ timeout: 5_000 });
  const boxAtZoom1 = await page.getByTestId('ccs-hover-outline').boundingBox();
  const contentBoxAtZoom1 = await pageBoundingBox(page, heading, SELECTION_FIXTURE_NAME);
  expect(boxAtZoom1).not.toBeNull();
  expect(Math.abs(boxAtZoom1!.width - contentBoxAtZoom1.width)).toBeLessThan(5);

  // Zoom in (Ctrl+wheel = zoom, matching acceptance.spec.ts test (d)'s
  // established gesture) — edit mode does NOT lock the camera (see
  // `CcsFrameShapeUtil.onDoubleClick`'s doc comment: only the initial
  // snap-to-frame is automatic; further zoom/pan stays live), so ordinary
  // zoom gestures should still move the camera exactly as they would
  // outside edit mode.
  // A handful of steps is enough to prove the transform tracks a REAL zoom
  // change (each ctrl+wheel tick multiplies zoom by roughly 1+delta*speed,
  // so this compounds fast — kept small deliberately so the resulting
  // camera stays sane for whatever test runs next).
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -50);
    await page.keyboard.up('Control');
    await page.waitForTimeout(16);
  }

  await hoverCenter(page, heading, SELECTION_FIXTURE_NAME);
  await expect(page.getByTestId('ccs-hover-outline')).toBeVisible({ timeout: 5_000 });
  const boxAtZoom2 = await page.getByTestId('ccs-hover-outline').boundingBox();
  const contentBoxAtZoom2 = await pageBoundingBox(page, heading, SELECTION_FIXTURE_NAME);
  expect(boxAtZoom2).not.toBeNull();
  expect(Math.abs(boxAtZoom2!.width - contentBoxAtZoom2.width)).toBeLessThan(5);

  // The overlay tracked the real content at BOTH zoom levels even though
  // the actual on-screen size changed between them — proof the transform
  // (not a fixed/stale box) drove both renders.
  expect(Math.abs(boxAtZoom2!.width - boxAtZoom1!.width)).toBeGreaterThan(5);

  await exitEditMode(page);
});

test('(l) Esc exits edit mode: pointer-events revert and the P1 pan/zoom gesture still works afterward', async () => {
  await enterEditModeByHeader(page, SELECTION_FIXTURE_NAME);
  const header = page.getByText(SELECTION_FIXTURE_NAME, { exact: true });

  await exitEditMode(page);
  await expect(page.getByTestId('ccs-breadcrumb-bar')).toHaveCount(0);

  // Ordinary P1 pan still works post-exit (camera unlocked) — smoke check,
  // not a pixel-exact assertion: the header's on-screen position must
  // change after a wheel pan.
  const before = await header.boundingBox();
  await page.mouse.wheel(300, 0);
  await page.waitForTimeout(50);
  const after = await header.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((before?.x ?? 0) - (after?.x ?? 0))).toBeGreaterThan(1);
});
