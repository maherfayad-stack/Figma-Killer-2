import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import prettier from 'prettier';
import { openProject, type DaemonHandle } from '@ccs/sync-daemon';
import { applyOp, buildTree } from '@ccs/ast-engine';
import { transformSourceUid } from '@ccs/vite-plugin-source-uid';
import type { FrameMeta, NodeUid, TreeNode } from '@ccs/protocol';
import { buildNewCanvasJsonEntry, frameSourcePath, patchFramesRegistry } from '@ccs/canvas';

/**
 * ============================================================================
 * P5 JOINT ACCEPTANCE — Playwright e2e driving the REAL studio chrome
 * (`apps/studio`) against the REAL sync-daemon + a REAL file-app
 * (`files/demo`), playbook §4/P5 + this task's brief. Mirrors
 * `packages/canvas/e2e`'s discipline: boots real processes, mutates the
 * repo's own `files/demo` fixture, reverts everything in `afterAll`.
 *
 * Run: `pnpm --filter @ccs/studio run test:e2e`
 *
 * Covers:
 *   (a) build a small landing page using ONLY the studio UI (select a
 *       layer, edit its text, set a layout class) -> the resulting file is
 *       prettier-formatted, minimally diffed, and the file-app still BUILDS
 *       (real P3 ast-engine + real daemon — no mocking on this path).
 *   (b) component-insert + token-bind emit the CORRECT `CanvasOp` shapes
 *       (asserted via the dev-only `window.__ccsOpsLog`) against the REAL
 *       `@ccs/tokens` engine (P4 landed; wired via `../../vite.config.ts`'s
 *       dev-server catalog bridge — see its module doc), independent of
 *       whether the daemon accepts a still-unsupported `{token}` set-prop,
 *       ADR-0019 decision 6.
 *   (c) RTL: the chrome renders correctly under `dir="rtl"` (dock panels
 *       mirror via CSS logical properties + native `direction` cascade).
 *   (d) Inspector: a dynamic node renders READ-ONLY + "Open in IDE"; a
 *       static node renders editable controls (playbook §0 contract).
 * ============================================================================
 */

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'files', 'demo');
const HERO_TSX = join(DEMO_ROOT, 'src', 'frames', 'Hero.tsx');
const FRAMES_TS = join(DEMO_ROOT, 'src', 'frames.ts');
const CANVAS_JSON = join(DEMO_ROOT, '.studio', 'canvas.json');
const STUDIO_ROOT = join(REPO_ROOT, 'apps', 'studio');

const STUDIO_PORT = 5557;
const DAEMON_PORT_START = 4780;
const FRAME_SERVER_PORT_START = 5280;

// Dynamic-node acceptance fixture (see this file's module doc (d)/(i)) — a
// REAL frame file so it shows up in the studio's PagesPanel (which only
// lists real daemon-reported frames) AND in the LIVE `tree-snapshot` the
// daemon now emits from this exact file (P5 RESUME item 1/2 — no more
// hand-authored `tree-fixtures.ts` mock in the production path). Hand-
// written (not `buildFrameSource`'s generic static template) specifically
// so it contains a REAL `.map()`-generated dynamic subtree (playbook §0
// editable-surface contract) for test (i) below to select against.
const TESTIMONIALS_NAME = 'Testimonials';
const TESTIMONIALS_TSX = join(DEMO_ROOT, frameSourcePath(TESTIMONIALS_NAME));
const TESTIMONIALS_SOURCE = `export default function Testimonials() {
  const quotes = ["Great product", "Loved it"];
  return (
    <section>
      <h2>Testimonials</h2>
      <div>
        {quotes.map((quote) => (
          <article key={quote}>
            <p>{quote}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
`;

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

  await writeFile(TESTIMONIALS_TSX, TESTIMONIALS_SOURCE, 'utf8');
  const patchedFramesTs = patchFramesRegistry(originalFramesTs, TESTIMONIALS_NAME);
  await writeFile(FRAMES_TS, patchedFramesTs, 'utf8');
  const meta: FrameMeta = JSON.parse(originalCanvasJson);
  meta.frames.push(buildNewCanvasJsonEntry(meta.frames, TESTIMONIALS_NAME));
  await writeFile(CANVAS_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  daemon = await openProject({
    projectRoot: REPO_ROOT,
    studioMode: true,
    daemonPortStart: DAEMON_PORT_START,
    frameServerPortStart: FRAME_SERVER_PORT_START,
  });
  console.log(`[e2e] real daemon up: control-ws ws://127.0.0.1:${daemon.daemonPort}`);

  viteServer = await createViteServer({
    root: STUDIO_ROOT,
    server: { port: STUDIO_PORT, strictPort: true, host: '127.0.0.1' },
  });
  await viteServer.listen();
  console.log(`[e2e] studio chrome up: http://127.0.0.1:${STUDIO_PORT}`);
});

test.afterAll(async () => {
  await viteServer?.close();
  await daemon?.close();
  await rm(TESTIMONIALS_TSX, { force: true });
  await writeFile(HERO_TSX, originalHeroSource, 'utf8');
  await writeFile(FRAMES_TS, originalFramesTs, 'utf8');
  await writeFile(CANVAS_JSON, originalCanvasJson, 'utf8');
  console.log('[e2e] files/demo fixture restored to its original state');
});

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${STUDIO_PORT}/?daemonPort=${daemon.daemonPort}`);
  await expect(page.getByTestId('project-card').filter({ hasText: 'Demo' })).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  await context?.close();
});

async function openDemoWorkspace(): Promise<void> {
  await page.getByTestId('project-card').filter({ hasText: 'Demo' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-connected', 'true', { timeout: 10_000 });
}

async function selectFrame(name: string): Promise<void> {
  await page.getByRole('tab', { name: 'Pages' }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('tab', { name: 'Layers' }).click();
}

/** Reads the `selected: <uid>` text StatusBar.tsx renders once a node is
 * selected (`workspace-store`'s `selectedUid`) — the ONE place in the
 * studio chrome DOM that exposes the raw uid string for a test to read. */
async function readSelectedUidFromStatusBar(): Promise<string> {
  const text = await page.getByTestId('statusbar').innerText();
  const match = /selected: (\S+)/.exec(text);
  if (!match) throw new Error(`statusbar did not render a selected uid: "${text}"`);
  return match[1]!;
}

/** Pre-order-flattens a `TreeNode` (root first, then children, skipping
 * fragments — they carry no DOM node/data-uid, same rule build-tree's own
 * conformance test uses) — for comparing document-order position against
 * the babel-tagged output's `data-uid` sequence below. */
function flattenTreeNodes(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  if (node.kind !== 'fragment') out.push(node);
  for (const child of node.children) flattenTreeNodes(child, out);
  return out;
}

/** Every `data-uid="..."` value in the babel-transformed source, in
 * DOCUMENT (textual) order — a parent's opening tag always precedes its
 * children's in the source text, so this order lines up 1:1 with
 * `flattenTreeNodes`'s pre-order walk of the SAME source (this is exactly
 * the comparison method `packages/ast-engine/src/build-tree.test.ts`'s own
 * ADR-0017 conformance test uses). */
function extractDataUidsInOrder(transformedCode: string): string[] {
  const uids: string[] = [];
  const pattern = /data-uid="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(transformedCode))) uids.push(match[1]!);
  return uids;
}

test('(a) opening the Demo project connects the real studio chrome to the real daemon', async () => {
  await openDemoWorkspace();
  await expect(page.getByTestId('toolbar')).toBeVisible();
});

test('(b) Pages -> Layers: selecting Hero shows its LIVE daemon-derived layer tree, updates live on a real file edit, and a Layers-selected uid === the P2 bridge uid === an applyOp target', async () => {
  await selectFrame('Hero');
  const tree = page.getByTestId('layers-tree');
  await expect(tree).toBeVisible();
  await expect(tree.getByText('h1', { exact: true })).toBeVisible();
  await expect(tree.getByText('p', { exact: true })).toBeVisible();
  await expect(tree.getByText('button', { exact: true }).first()).toBeVisible();

  // --- liveness (P5 RESUME item 1/2): the panel above is now backed by a
  // REAL `tree-snapshot` DaemonEvent (`packages/sync-daemon/src/tree-
  // snapshot.ts`), not the retired `tree-fixtures.ts` mock. Prove it by
  // editing the REAL file on disk (no Inspector/op involved) and watching
  // the LayersPanel pick up a brand-new node, then revert — leaving
  // `HERO_TSX` byte-identical to `originalHeroSource` before test (c)
  // (which asserts an exact minimal diff against it) runs. ---
  const LIVE_MARKER_TAG = 'blockquote';
  const liveEditedSource = originalHeroSource.replace(
    '</section>',
    `      <${LIVE_MARKER_TAG}>live edit marker</${LIVE_MARKER_TAG}>\n    </section>`,
  );
  await writeFile(HERO_TSX, liveEditedSource, 'utf8');
  await expect(tree.getByText(LIVE_MARKER_TAG, { exact: true })).toBeVisible({ timeout: 10_000 });

  await writeFile(HERO_TSX, originalHeroSource, 'utf8');
  await expect(tree.getByText(LIVE_MARKER_TAG, { exact: true })).toHaveCount(0, { timeout: 10_000 });
  expect(await readFile(HERO_TSX, 'utf8')).toBe(originalHeroSource); // fixture restored before test (c)/(d)/(e)

  // --- uid consistency (this task's core acceptance bullet): the uid the
  // LayersPanel puts into `selectedUid` for the <p> node must be BYTE-
  // IDENTICAL to (1) what ast-engine's `buildTree` (the exact function the
  // daemon just used to build the tree above) assigns it, (2) what the
  // REAL `@ccs/vite-plugin-source-uid` babel plugin (what the P2 bridge
  // actually tags `data-uid` with in the live iframe DOM) assigns the SAME
  // node, and (3) a uid `applyOp` (P3's real write-back engine) can
  // resolve to precisely that node and no other. ---
  await tree.getByText('p', { exact: true }).click();
  const selectedUid = await readSelectedUidFromStatusBar();

  const liveTree = buildTree(originalHeroSource, 'src/frames/Hero.tsx');
  const treeNodes = flattenTreeNodes(liveTree);
  const selectedIndex = treeNodes.findIndex((n) => n.uid === selectedUid);
  expect(selectedIndex).toBeGreaterThanOrEqual(0);
  expect(treeNodes[selectedIndex]?.tag).toBe('p'); // sanity: really the <p>, not some other node

  // (2) tree uid === bridge uid: same document-order position in the REAL
  // babel-tagged output the bridge injects into the iframe.
  const { code: babelTaggedCode } = transformSourceUid(originalHeroSource, { relPath: 'src/frames/Hero.tsx' });
  const babelUids = extractDataUidsInOrder(babelTaggedCode);
  expect(babelUids[selectedIndex]).toBe(selectedUid);

  // (3) tree uid === applyOp target: a pure, offline (no daemon mutation —
  // real op-driven writes are covered by test (c)/(d)) `set-text` against
  // this exact uid changes ONLY the <p> line, never <h1>/<button>.
  const probe = applyOp(originalHeroSource, {
    t: 'set-text',
    uid: selectedUid as NodeUid,
    text: 'UID_CONSISTENCY_PROBE',
  });
  expect(probe.newText).toContain('UID_CONSISTENCY_PROBE');
  expect(probe.newText).toContain('Plan your next trip effortlessly'); // h1 untouched
  expect(probe.newText).toContain('Start planning'); // button untouched
});

test('(c) editing a static layer’s text via the Inspector writes the REAL Hero.tsx through the real P3 engine, prettier-formatted, minimally diffed', async () => {
  const MARKER = 'HMR ACCEPTANCE MARKER';
  await page.getByTestId('layers-tree').getByText('h1', { exact: true }).click();
  await expect(page.getByTestId('dynamic-readonly')).toHaveCount(0);

  const textInput = page.getByLabel('Text', { exact: true });
  await textInput.fill(MARKER);
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect
    .poll(async () => (await readFile(HERO_TSX, 'utf8')).includes(MARKER), { timeout: 10_000 })
    .toBe(true);

  const written = await readFile(HERO_TSX, 'utf8');
  const prettierConfig = JSON.parse(await readFile(join(REPO_ROOT, '.prettierrc.json'), 'utf8'));
  const formatted = await prettier.format(written, { ...prettierConfig, parser: 'typescript' });
  expect(written, 'ast-engine output must already be prettier-formatted (playbook §5.3)').toBe(formatted);

  // "git diff clean" without running git (this phase runs no git commands):
  // only the h1's text changed, every other line is byte-identical to the
  // original fixture.
  const beforeLines = originalHeroSource.split('\n');
  const afterLines = written.split('\n');
  const changedLines = afterLines.filter((line, i) => line !== beforeLines[i]);
  expect(changedLines.some((l) => l.includes(MARKER))).toBe(true);
  expect(afterLines.length).toBe(beforeLines.length); // no stray line insertions/deletions
  const unchangedCount = afterLines.filter((line, i) => line === beforeLines[i]).length;
  expect(unchangedCount).toBeGreaterThanOrEqual(beforeLines.length - 1); // exactly the one line differs
});

test('(d) setting a layout class via the Inspector adds a real Tailwind class to Hero.tsx', async () => {
  await page.getByTestId('layers-tree').getByText('button', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Gap 2', exact: true }).click();

  await expect
    .poll(async () => (await readFile(HERO_TSX, 'utf8')).includes('gap-2'), { timeout: 10_000 })
    .toBe(true);
  console.log('[e2e] (d) gap-2 class landed in Hero.tsx via a real set-classes op');
});

test('(e) the file-app still builds after the real studio-driven edits', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.platform === 'win32' ? 'vite.cmd' : 'vite',
    ['build'],
    { cwd: DEMO_ROOT, env: process.env, encoding: 'utf8' },
  ).catch((err: unknown) => {
    throw new Error(`vite build failed: ${String(err)}`);
  });
  console.log('[e2e] (e) vite build stdout tail:', stdout.slice(-400));
  expect(stderr, 'vite build should not report errors').not.toMatch(/error/i);
});

test('(f) component-insert emits insert-node(ds-component) + defaulted set-prop ops (REAL @ccs/tokens catalog, ADR-0021 pattern)', async () => {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.evaluate(() => {
    (window as unknown as { __ccsOpsLog: unknown[] }).__ccsOpsLog = [];
  });
  // `SegmentedControl` (real `design-system/src/components/SegmentedControl.
  // meta.ts`) is one of only two real Almosafer DS components whose meta.ts
  // has a prop that is BOTH `required: true` AND carries a `default`
  // (`items: {default: [], required: true}`) — the exact combination
  // `use-component-insert.ts` client-side-defaults (ADR-0021 decision 6 /
  // ADR-0022 integration). The real `Button.meta.ts` (unlike this suite's
  // earlier mock-adapter placeholder) has no required+defaulted prop, so it
  // can't exercise this path against the REAL catalog.
  await page
    .getByText('SegmentedControl', { exact: true })
    .locator('xpath=ancestor::div[1]')
    .getByRole('button', { name: 'Insert' })
    .click();

  const ops = await page.evaluate(() => (window as unknown as { __ccsOpsLog: { op: { t: string } }[] }).__ccsOpsLog);
  expect(ops.some((e) => e.op.t === 'insert-node')).toBe(true);
  expect(ops.some((e) => e.op.t === 'set-prop')).toBe(true);
  console.log(`[e2e] (f) component-insert emitted ${ops.length} ops: ${ops.map((o) => o.op.t).join(', ')}`);
});

test('(g) Inspector token-bind (Fill section) emits a set-prop op with a {token} value (REAL @ccs/tokens catalog)', async () => {
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByTestId('layers-tree').getByText('h1', { exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __ccsOpsLog: unknown[] }).__ccsOpsLog = [];
  });

  // `aqua100` is a real Almosafer DS brand color token (`design-system/src/
  // tokens/tokens.js`'s `colors` export) — the mock adapter's placeholder
  // `color.primary` naming doesn't exist in the real token model.
  await page.getByLabel('Bind token').selectOption({ label: 'aqua100' });
  await page.getByRole('button', { name: 'Bind', exact: true }).click();

  const ops = await page.evaluate(() => (window as unknown as { __ccsOpsLog: { op: Record<string, unknown> }[] }).__ccsOpsLog);
  const tokenOp = ops.find((e) => e.op['t'] === 'set-prop');
  expect(tokenOp).toBeDefined();
  expect(tokenOp?.op['value']).toEqual({ token: 'aqua100' });
  console.log('[e2e] (g) token-bind emitted set-prop with a {token} value:', JSON.stringify(tokenOp?.op));
});

test('(h) RTL: the dock panels mirror under dir="rtl" (CSS logical properties + native direction cascade)', async () => {
  const rtlPage = await context.newPage();
  await rtlPage.goto(`http://127.0.0.1:${STUDIO_PORT}/?daemonPort=${daemon.daemonPort}&dir=rtl`);
  await expect(rtlPage.getByTestId('project-card').first()).toBeVisible({ timeout: 15_000 });
  expect(await rtlPage.evaluate(() => document.documentElement.dir)).toBe('rtl');

  await rtlPage.getByTestId('project-card').filter({ hasText: 'Demo' }).getByRole('button', { name: 'Open' }).click();
  await expect(rtlPage.getByTestId('workspace-shell')).toBeVisible();

  const leftDockBox = await rtlPage.getByTestId('dock-left').boundingBox();
  const rightDockBox = await rtlPage.getByTestId('dock-right').boundingBox();
  expect(leftDockBox && rightDockBox).toBeTruthy();
  // Under RTL, the DOM-first dock ("left" in source order, Pages/Layers/
  // Assets/Tokens) renders on the PHYSICAL RIGHT — mirrored from LTR — since
  // the grid container inherits `direction:rtl` and every primitive inside
  // uses logical (not physical) properties.
  expect(leftDockBox!.x).toBeGreaterThan(rightDockBox!.x);
  await rtlPage.close();
});

test('(i) Inspector: a dynamic node (Testimonials fixture, a REAL .map() in the live file) is read-only with "Open in IDE"; a static node is editable', async () => {
  await selectFrame(TESTIMONIALS_NAME);
  const tree = page.getByTestId('layers-tree');
  await expect(tree).toBeVisible();
  // `h2`/`div` are the LIVE tree's top-level rows (`section`'s children —
  // the root itself is never its own row, see `LayersPanel.tsx`); confirms
  // the panel is rendering the REAL daemon-derived tree for this file, not
  // a stale/fixture one.
  await expect(tree.getByText('h2', { exact: true })).toBeVisible();

  // Expand down to a dynamic (.map()-generated) leaf: `div` (the mapped-
  // list container) -> the mapped `article` itself -> its `p` child. Both
  // `article` and `p` are inside the source's `.map()` callback, so both
  // are `dynamic:true` (playbook §0 editable-surface contract) — real
  // ast-engine `buildTree` output, not a hand-authored mock.
  await page.getByRole('button', { name: 'Expand' }).first().click(); // expand div
  await page.getByRole('button', { name: 'Expand' }).first().click(); // expand the article (only remaining expandable row)
  const dynamicBadges = tree.getByTestId('dynamic-badge');
  await expect(dynamicBadges.first()).toBeVisible();
  await dynamicBadges.first().locator('xpath=ancestor::div[@role="treeitem"]').click();

  await expect(page.getByTestId('dynamic-readonly')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in IDE' })).toBeVisible();
  await expect(page.getByLabel('Text', { exact: true })).toHaveCount(0);

  // Back to a static node -> editable Content section reappears.
  await selectFrame('Hero');
  await page.getByTestId('layers-tree').getByText('h1', { exact: true }).click();
  await expect(page.getByTestId('dynamic-readonly')).toHaveCount(0);
  await expect(page.getByLabel('Text', { exact: true })).toBeVisible();
});
