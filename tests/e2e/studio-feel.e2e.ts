import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { BUDGET_ZOOM_MEAN_FRAME_MS, BUDGET_ZOOM_WORST_FRAME_MS, profileGesture, readBoardCounts } from './helpers/canvasPerf'
import { WORKSPACE_ROOT } from './helpers/constants'
import { canvasContentFrame, selectionRings, settleCanvasFrameMode, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  countSourceOccurrences,
  createFixtureProject,
  decodeNodeSourceLocation,
  readNodeSourceFile,
  removeFixtureProject,
  sourceLineAt,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * `STUDIO-FIGMA-FEEL-PLAN.md` V1 — the browser gate for "does this feel like a
 * design tool", run in CI as the `e2e-budgets` job (`.github/workflows/ci.yml`).
 *
 * Every claim here is about a **refusal or a ceiling**, not a happy path:
 *
 *   1. **Five presses, five writes, no card.** Hammering ⌘D five times writes
 *      five copies into the `.tsx` and creates NO toast card: a press that
 *      arrives mid-write is queued, not refused (`structuralCommitQueue.ts`),
 *      and a structural commit never toasts success (P3-A). Stacked cards were
 *      the single most-reported piece of noise in this editor (`Z1`), and
 *      nothing but a real browser can count the cards a user actually sees.
 *      The assertion is on the NUMBER of toast cards ever created, never on
 *      their wording.
 *   2. **Escape always terminates.** The Escape ladder may have any number of
 *      rungs (today: step out of an entered instance, then clear), but it must
 *      never widen a selection, must reach "nothing selected" in a bounded
 *      number of presses, and must be a no-op once there. The reported defect
 *      `select-01` fixed was a ladder that silently stopped moving.
 *   3. **A zoom does not stutter.** Same `profileGesture` instrumentation
 *      `studio-board-perf.e2e.ts` uses, so the two numbers are comparable.
 *      This spec's corpus (`studio-workspace/test4`) is committed to the repo,
 *      which is what makes this budget gateable in CI at all — the eSIM corpus
 *      `studio-board-perf.e2e.ts` measures is NOT tracked by git, so that spec
 *      skips itself on a clean CI checkout.
 *   4. **Alt+drag duplicates a board frame** (`K2`). Skipped, out loud, with a
 *      named reason until the frame chrome carries `data-gesture="alt-duplicate"`.
 *      A test that silently passes because the feature is missing is worse than
 *      no test.
 *
 * SAFETY — ⌘D **writes to the user's `.tsx`**. Two layers keep that off the
 * tracked tree. The run's whole workspace is already a throwaway copy
 * (`WORKSPACE_ROOT`, made by `scripts/e2e-dev.ts`), and on top of that this
 * spec still never opens that copy's `test4` directly: `beforeAll` copies it to
 * `__e2e-studio-feel/` and every test opens THAT, which `afterAll` removes.
 * The second layer is not redundant — specs share one workspace for the whole
 * serial run, so a spec that structurally edits `test4` would change what every
 * later spec reads. The copy must live under the workspace root (not `.tmp/`)
 * or `resolveProjectDir`'s containment check 404s it — the same constraint
 * `scripts/bench/lib/liveFrameFixture.ts` documents.
 */


/**
 * `K2`'s marker on the board-frame chrome. Until the Alt+drag session exists
 * there is nothing to drive, and phase 4 says so instead of passing.
 */
const ALT_DUPLICATE_MARKER = '[data-gesture="alt-duplicate"]'

/**
 * `speed-05` — `STUDIO-SPEED-PLAN.md`'s gate for a refused structural
 * gesture: keydown → `RefusalDialog` visible. The work order's own target
 * (measured against the 393 ms defect) is ≤ 50 ms "visible response"; this
 * gate keeps a wider margin (2×) for CI machine noise around the actual DOM
 * mount `startTransition` no longer blocks the keydown task on — tighten it
 * only after re-measuring on the CI runner, not this machine.
 */
const BUDGET_REFUSAL_DIALOG_MS = 100

/** Fixed name, not per-PID: a crashed run's leftovers are visibly overwritten rather than accumulating. */
const FIXTURE_DIR = path.join(WORKSPACE_ROOT, '__e2e-studio-feel')

/**
 * `speed-05`'s always-refused delete target — see {@link patchInStructuralRefusalTarget}.
 * Matched by TEXT, not a `data-testid`: the canvas module renderer (`base.text`
 * / `base.container`) only forwards a fixed prop vocabulary onto the DOM node
 * it mounts, so an arbitrary custom attribute authored in the `.tsx` never
 * reaches the rendered element — measured directly against this exact
 * fixture (the attribute silently dropped, the text child rendered fine).
 */
const STRUCTURAL_REFUSAL_TARGET_TEXT = 'STILL_REFUSED_DELETE_TARGET'

let fixtureReady = false
let fixture: FixtureProject | undefined

test.beforeAll(() => {
  // The shared helper, not a raw rm + copy: when Playwright restarts a worker
  // after a failure, the fixture's own dev server and the server's watcher
  // still hold the directory, and deleting it fails with EPERM on Windows.
  // `createFixtureProject` overwrites it in place instead.
  fixture = createFixtureProject('test4', path.basename(FIXTURE_DIR))
  fixtureReady = fixture.ready
  if (fixtureReady) patchInStructuralRefusalTarget()
})

/**
 * `speed-05` needs a delete that STAYS refused so the dialog it measures ever
 * mounts. `shared-component` no longer qualifies: P5-C (OD-7,
 * `instanceOnlyGesture.ts`) made the store detach a refused instance and
 * replay the gesture against the detached markup instead of asking — an
 * async round trip (a `/save`, a reparse) that resolves the delete silently,
 * with no dialog at all (`RefusalDialog.tsx`'s own doc: "…never reaches this
 * dialog"). Confirmed empirically against this exact fixture (the iOS status
 * bar clock): the element is gone from the canvas ~15s after the keydown, and
 * `[role="alertdialog"]` never once appeared.
 *
 * A JSX spread attribute is the one lock `refusePlacement` still answers
 * unconditionally and synchronously — `code-placed`, no OD-7 remedy exists
 * for it, so `presentStructuralRefusal` goes straight to `openDialog()`. This
 * appends one ordinary, always-refused element as the LAST child of `<main>`,
 * after the existing footer — deliberately not the first: `firstLeafNode`
 * (the ⌘D test's target) walks the frame in document order, and this element
 * must not become "the first leaf on the board" for that unrelated test.
 */
function patchInStructuralRefusalTarget(): void {
  const file = path.join(FIXTURE_DIR, 'pages', 'Onboarding.tsx')
  const source = fs.readFileSync(file, 'utf8')
  const marker = '    </main>'
  if (!source.includes(marker)) {
    throw new Error(
      "patchInStructuralRefusalTarget: Onboarding.tsx's <main> no longer closes the way this patch expects",
    )
  }
  const injected =
    `      {/* speed-05 e2e fixture patch — an ordinary element with no honest single writeback target */}\n` +
    `      <div {...{}}>${STRUCTURAL_REFUSAL_TARGET_TEXT}</div>\n` +
    marker
  fs.writeFileSync(file, source.replace(marker, injected), 'utf8')
}

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

/** Board frames recorded on disk, across every board in the project. */
function frameIdsOnDisk(): string[] {
  const boardsPath = path.join(FIXTURE_DIR, '.studio', 'boards.json')
  const raw: unknown = JSON.parse(fs.readFileSync(boardsPath, 'utf8'))
  const boards = (raw as { boards?: Array<{ frames?: Array<{ id?: string }> }> }).boards ?? []
  return boards.flatMap((board) => (board.frames ?? []).map((frame) => frame.id ?? ''))
}

/**
 * Opens the ephemeral copy's board. Auto-save is switched off so the only
 * writes this spec can make are the structural ones it deliberately drives —
 * and those land in the copy, never in `test4`.
 */
async function openFixtureBoard(page: Page): Promise<Locator> {
  await page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
    window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: false }))
  }, FIXTURE_DIR)

  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 90_000 })
  await bringAFrameOnScreen(page, canvasRoot)
  return canvasRoot
}

/**
 * Get at least one board frame to mount a live iframe.
 *
 * Frames are virtualized: a frame outside the viewport renders a poster or a
 * placeholder, never an iframe. `test4`'s frames sit around `y: 901`,
 * `x: -422..423` on the board, so whether the default view contains one at all
 * depends on the canvas's "center on open" pass having run — which, on a cold
 * load, can race the arrival of the page documents it centres on. Waiting
 * longer does not fix a view that is simply pointed elsewhere.
 *
 * So: reset the view with the product's own Ctrl+0, and if that still shows
 * nothing, zoom out (sign-safe, unlike guessing a pan direction) until a frame
 * is on screen. Failing after all of that is a real failure, and says so.
 */
async function bringAFrameOnScreen(page: Page, canvasRoot: Locator): Promise<void> {
  const anyFrame = visibleCanvasIframe(page).first()
  if (await anyFrame.isVisible({ timeout: 30_000 }).catch(() => false)) return

  await canvasRoot.focus()
  await page.keyboard.press('Control+0')
  await page.waitForTimeout(600)

  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await anyFrame.isVisible({ timeout: 1_000 }).catch(() => false)) return
    await page.keyboard.press('-')
    await page.waitForTimeout(400)
  }

  throw new Error(
    'no board frame ever mounted a live canvas iframe, even after resetting the view and zooming out — ' +
      'the fixture board never rendered',
  )
}

/** Same pan mechanism as `canvas-deselect.e2e.ts` / `frame-fit-height.e2e.ts`. */
async function panIntoView(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  tolerancePx = 40,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) throw new Error('panIntoView: target has no bounding box')

    const rootCenterX = rootBox.x + rootBox.width / 2
    const rootCenterY = rootBox.y + rootBox.height / 2
    const dx = targetBox.x + targetBox.width / 2 - rootCenterX
    const dy = targetBox.y + targetBox.height / 2 - rootCenterY
    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target never reached the viewport center after 8 pan attempts')
}

/**
 * Click an element rendered INSIDE a canvas iframe with real mouse
 * coordinates. `locator.click()`'s actionability wants to scroll the element
 * into view and the canvas pans via a CSS transform (no scroll container), so
 * it would hang. Same helper shape as `canvas-deselect.e2e.ts`.
 */
async function clickInFrame(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

/**
 * A leaf node inside the first live frame: the deepest `[data-node-id]` that
 * has no `[data-node-id]` descendant and renders at a clickable size. Derived
 * rather than hardcoded to a class name so an edit to the fixture project
 * cannot silently retarget this spec at the page root.
 */
async function firstLeafNode(contentFrame: FrameLocator): Promise<Locator> {
  const candidates = contentFrame.locator('[data-node-id]:not(:has([data-node-id]))')
  await expect(
    candidates.first(),
    'the fixture frame rendered no leaf [data-node-id] element',
  ).toBeVisible({ timeout: 30_000 })

  const count = await candidates.count()
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i)
    const box = await candidate.boundingBox().catch(() => null)
    if (box && box.width >= 12 && box.height >= 12) return candidate
  }
  throw new Error('firstLeafNode: no leaf node in the frame is large enough to click')
}

/**
 * `speed-05` — a leaf node whose delete is REFUSED with a runnable remedy
 * (`RefusalDialog`, not a toast), and stays that way: `patchInStructuralRefusalTarget`
 * writes it into the fixture's `Onboarding.tsx` as a plain element carrying a
 * JSX spread attribute, which the parser locks `code-placed`
 * (`parsePageFile.ts`'s `SPREAD_LOCK_REASON`) — a reason `refusePlacement`
 * answers unconditionally, with no OD-7 (`instanceOnlyGesture.ts`) remedy that
 * could resolve it silently. See that function's own doc for why the iOS
 * status bar clock this case used to target no longer belongs here: its
 * `shared-component` refusal now auto-detaches and replays instead of asking.
 */
async function structuralRefusalTarget(contentFrame: FrameLocator): Promise<Locator> {
  const target = contentFrame.getByText(STRUCTURAL_REFUSAL_TARGET_TEXT, { exact: true })
  await expect(
    target,
    'the fixture frame never rendered the patched-in refusal target — nothing here would refuse a delete',
  ).toBeVisible({ timeout: 30_000 })
  return target
}

/**
 * `speed-05` — the budget for a refused structural gesture: real DOM time
 * from the keydown the browser dispatches to `RefusalDialog`'s first paint,
 * not a proxy for it. A capture-phase `window` listener records the keydown
 * timestamp (capture so it fires before any handler that might
 * `stopPropagation`), and a `MutationObserver` on `document.body` records the
 * first moment `[role="alertdialog"]` — `RefusalDialog`'s own role, `tone`
 * is always `'danger'` — appears. `ConfirmDeleteDialog` shares the role but
 * never mounts here: `confirmBeforeDelete` defaults to `false`, so
 * `requestDeleteNode`'s `commit` runs synchronously and the refusal is the
 * only alertdialog this gesture can open.
 */
async function startRefusalTiming(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { keydownAt: 0, dialogVisibleAt: 0, observer: null as MutationObserver | null }
    window.__studioRefusalTiming = state

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (state.keydownAt !== 0) return
      state.keydownAt = performance.now()
      window.removeEventListener('keydown', onKeyDown, true)
    }
    window.addEventListener('keydown', onKeyDown, true)

    state.observer = new MutationObserver(() => {
      if (state.dialogVisibleAt !== 0) return
      if (document.querySelector('[role="alertdialog"]')) state.dialogVisibleAt = performance.now()
    })
    state.observer.observe(document.body, { subtree: true, childList: true })
  })
}

/** Reads back `startRefusalTiming`'s two timestamps and tears the sampler down. */
async function readRefusalTiming(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__studioRefusalTiming
    if (!state) throw new Error('the refusal timing sampler was never installed')
    state.observer?.disconnect()
    delete window.__studioRefusalTiming
    if (state.keydownAt === 0) throw new Error('no Delete keydown was ever observed')
    if (state.dialogVisibleAt === 0) throw new Error('RefusalDialog never appeared')
    return state.dialogVisibleAt - state.keydownAt
  })
}

/**
 * Records every toast CARD created from now on, by kind.
 *
 * Counting cards at one instant would be a race against the auto-dismiss timer
 * (4 s for non-errors) and against five asynchronous writes landing at
 * different moments. A `MutationObserver` over the portal instead counts every
 * card that was ever inserted, which is precisely what "the user saw five
 * cards" means. A de-duplicated repeat REPLACES a toast in place under the
 * same React `key`, so it inserts no new node — the number this returns is the
 * number of distinct cards, not the number of pushes.
 */
async function startToastRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const created: Array<{ kind: string; title: string }> = []
    const record = (node: Node) => {
      if (!(node instanceof HTMLElement)) return
      const cards = node.matches('[data-toast-kind]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-toast-kind]'))
      for (const card of cards) {
        created.push({
          kind: card.getAttribute('data-toast-kind') ?? 'unknown',
          title: card.textContent?.trim().slice(0, 80) ?? '',
        })
      }
    }
    const observer = new MutationObserver((records) => {
      for (const mutation of records) mutation.addedNodes.forEach(record)
    })
    observer.observe(document.body, { subtree: true, childList: true })
    window.__studioToastLog = { created, observer }
  })
}

async function readToastRecorder(page: Page): Promise<Array<{ kind: string; title: string }>> {
  return page.evaluate(() => {
    const log = window.__studioToastLog
    if (!log) throw new Error('the toast recorder was never installed')
    log.observer.disconnect()
    delete window.__studioToastLog
    return log.created
  })
}

/** Reads the current selection as a user sees it: the in-frame ring, plus any selected board frame. */
async function readSelection(
  page: Page,
  rings: Locator,
): Promise<{ ringCount: number; nodeId: string | null; selectedFrames: number }> {
  const ringCount = await rings.count()
  return {
    ringCount,
    nodeId:
      ringCount > 0 ? await rings.first().getAttribute('data-canvas-overlay-node-id') : null,
    selectedFrames: await page.locator('[data-page-id][data-selected="true"]').count(),
  }
}

/** Records a measurement on the test AND prints it — same convention as `studio-board-perf.e2e.ts`. */
function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[studio-feel] ${label}: ${value}`)
}


test.describe('V1: the studio feels like a design tool', () => {
  // Board open on a cold ts-morph parse, plus five structural writes.
  test.setTimeout(300_000)

  test.beforeEach(() => {
    test.skip(
      !fixtureReady,
      `studio-workspace/test4 is not present on disk, so the ephemeral fixture could not be made`,
    )
  })

  test('rapid ⌘D five times writes five copies and puts no toast card on screen', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page)
    const firstFrame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, firstFrame)
    // test4 is a Tier-2 Vite project whose dev server can boot here, so the
    // frame swaps from its portal fallback to the live frame some seconds in.
    // Settle first, so the click and the ring are read in the same document.
    const mode = await settleCanvasFrameMode(page, firstFrame, FIXTURE_DIR)
    annotate('frame mode', mode)

    const contentFrame = canvasContentFrame(firstFrame)
    const target = await firstLeafNode(contentFrame)
    await panIntoView(page, canvasRoot, target, 80)
    await clickInFrame(page, target)

    const rings = selectionRings(page, firstFrame, mode)
    await expect(rings, 'clicking a leaf node drew no selection ring').toHaveCount(1, {
      timeout: 15_000,
    })

    // What ⌘D duplicates is the SELECTION, which a click inside a component
    // instance resolves to the instance (P2-B), not necessarily the leaf that
    // was clicked. Read it off the ring, then count its source line's copies.
    const selectedId = await rings.first().getAttribute('data-canvas-overlay-node-id')
    const location = selectedId ? decodeNodeSourceLocation(selectedId) : null
    expect(location, `the selection (${selectedId}) carries no source location to count copies of`).not.toBeNull()
    const elementLine = sourceLineAt(readNodeSourceFile(fixture!, location!), location!.line)
    const occurrencesBefore = countSourceOccurrences(readNodeSourceFile(fixture!, location!), elementLine)
    const copiesAdded = (): number =>
      countSourceOccurrences(readNodeSourceFile(fixture!, location!), elementLine) - occurrencesBefore
    annotate('duplicating', `${selectedId} (in ${location!.rel})`)

    // `layers.duplicate` is a React `onKeyDown` on the canvas div
    // (`useCanvasKeyboardShortcuts.ts`), so the canvas has to hold DOM focus —
    // which is where it is after a canvas click in a real session. Clicking
    // inside the iframe focuses the IFRAME, and the keyboard bridge in
    // `useIframeEventForwarding.ts` re-dispatches on `document`, which no
    // React handler on a child div can see. Focus the canvas explicitly rather
    // than depend on that (K1's one-dispatcher work order is what closes the
    // gap; this spec must not silently become a test of it).
    await canvasRoot.focus()

    await startToastRecorder(page)

    // No waiting between presses: the point is the concurrent case. The 2nd..5th
    // arrive while the 1st is still in flight, and `structuralCommitQueue.ts`
    // parks each one and runs it next — five presses are five writes.
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Control+d')

    // The contract this case used to assert — "one success toast, at most one
    // collapsed 'Still writing' warning" — is gone on purpose, twice over: a
    // queued press is no longer refused (`structuralCommitQueue.ts`), and a
    // structural commit no longer toasts success (P3-A, `store-18`: "No
    // structural commit toasts success"). So the write is awaited in the FILE,
    // which is the document, and the toast contract is now "no card at all".
    await expect
      .poll(copiesAdded, {
        message: 'five ⌘D presses did not write five copies into the .tsx — presses were dropped rather than queued',
        timeout: 60_000,
      })
      .toBe(5)
    // Keep watching after the last write: a late card would be exactly the
    // defect this gate exists for. Auto-dismiss cannot hide one — the recorder
    // counts insertions, not what is on screen.
    await page.waitForTimeout(5_000)

    const created = await readToastRecorder(page)
    annotate('toast cards created by ⌘D ×5', String(created.length))
    annotate('their kinds', created.map((t) => t.kind).join(', ') || '(none)')
    annotate('their titles', created.map((t) => t.title).join(' | ') || '(none)')

    // Asserted on card COUNT and never on card copy.
    expect(
      created.map((t) => t.kind),
      'five rapid ⌘D presses put toast cards on screen: a structural commit never toasts success (P3-A), and a press that arrives mid-write is queued, never refused',
    ).toEqual([])
    expect(copiesAdded(), 'a sixth copy landed after the burst settled').toBe(5)
  })

  test('the Escape ladder never widens, always reaches nothing selected, and is a no-op there', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page)
    const firstFrame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, firstFrame)
    // Same hand-off as the ⌘D case: settle before the first click.
    const mode = await settleCanvasFrameMode(page, firstFrame, FIXTURE_DIR)
    annotate('frame mode', mode)

    const contentFrame = canvasContentFrame(firstFrame)
    const rings = selectionRings(page, firstFrame, mode)
    const target = await firstLeafNode(contentFrame)
    await panIntoView(page, canvasRoot, target, 80)
    await clickInFrame(page, target)
    await expect(rings, 'clicking a leaf node drew no selection ring').toHaveCount(1, {
      timeout: 15_000,
    })

    // Walk the ladder. Every rung must be at least as narrow as the one above
    // it — an Escape that selects something NEW (or re-selects a frame the
    // user had already left) is the ladder running backwards.
    const MAX_RUNGS = 4
    const ladder: string[] = []
    let previous = await readSelection(page, rings)
    ladder.push(`start: ring=${previous.ringCount} frames=${previous.selectedFrames}`)

    let cleared = false
    for (let rung = 0; rung < MAX_RUNGS; rung += 1) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      const current = await readSelection(page, rings)
      ladder.push(`escape ${rung + 1}: ring=${current.ringCount} frames=${current.selectedFrames}`)

      expect(
        current.ringCount,
        `Escape #${rung + 1} drew MORE selection rings than the rung above it — the ladder widened (${ladder.join(' → ')})`,
      ).toBeLessThanOrEqual(previous.ringCount)
      expect(
        current.selectedFrames,
        `Escape #${rung + 1} selected a board frame that was not selected before it — the ladder widened (${ladder.join(' → ')})`,
      ).toBeLessThanOrEqual(Math.max(previous.selectedFrames, 1))

      previous = current
      if (current.ringCount === 0 && current.selectedFrames === 0) {
        cleared = true
        break
      }
    }
    annotate('escape ladder', ladder.join(' → '))

    expect(
      cleared,
      `Escape never reached "nothing selected" within ${MAX_RUNGS} presses — this is the "I can't deselect" defect (${ladder.join(' → ')})`,
    ).toBe(true)

    // The bottom rung is a floor, not a trapdoor: one more Escape with nothing
    // selected must not close the project, leave the board, or resurrect a
    // selection.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const afterFloor = await readSelection(page, rings)
    expect(afterFloor.ringCount, 'an Escape at the bottom of the ladder re-selected a node').toBe(0)
    expect(afterFloor.selectedFrames, 'an Escape at the bottom of the ladder selected a frame').toBe(0)
    await expect(
      canvasRoot,
      'an Escape with nothing selected navigated away from the board',
    ).toBeVisible()
  })

  test('a scripted zoom stays inside its frame budget and really moves the canvas', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page)
    // The board's own "center on open" pass and the poster settle timer both
    // have to finish before "at rest" means anything.
    await page.waitForTimeout(2_500)

    const before = await readBoardCounts(page)
    annotate('board frames', String(before.boardFrames))
    annotate('live iframes before zoom', String(before.liveIframes))
    expect(before.boardFrames, 'the fixture board rendered no frames').toBeGreaterThan(0)

    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('canvas root has no bounding box')
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)

    // Same monotonic Ctrl+wheel zoom-out `studio-board-perf.e2e.ts` drives, and
    // the same deliberately-slow 150 ms step: slower than `useCanvas.ts`'s
    // 100 ms store-commit debounce, so a commit (and a virtualization pass)
    // lands BETWEEN wheel ticks instead of being left to scheduling luck.
    const zoom = await profileGesture(page, async () => {
      await page.keyboard.down('Control')
      for (let i = 0; i < 12; i += 1) {
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(150)
      }
      await page.keyboard.up('Control')
    })
    await page.waitForTimeout(800)

    const after = await readBoardCounts(page)
    annotate('live iframes after zoom', String(after.liveIframes))
    annotate('zoom worst frame', `${zoom.worstFrameMs.toFixed(1)}ms`)
    annotate('zoom mean frame', `${zoom.meanFrameMs.toFixed(1)}ms`)
    annotate('zoom frames >20ms', `${zoom.framesOver20ms}/${zoom.frames}`)
    annotate('zoom frames-layer mutations', String(zoom.layerMutations))
    annotate('zoom transform-layer style writes', String(zoom.transformWrites))

    // Without these two, every number above could be measuring an idle page.
    expect(
      zoom.transformWrites,
      'the zoom gesture never wrote a transform — the canvas did not move, so the frame times below prove nothing',
    ).toBeGreaterThan(0)
    expect(zoom.frames, 'the rAF sampler recorded almost no frames').toBeGreaterThan(10)

    expect(
      zoom.worstFrameMs,
      `the worst frame during a scripted zoom exceeded ${BUDGET_ZOOM_WORST_FRAME_MS}ms — read BUDGET_ZOOM_WORST_FRAME_MS's docblock before loosening it: it is a ratchet, S1 already lowered it once, and it is shared with studio-board-perf.e2e.ts`,
    ).toBeLessThan(BUDGET_ZOOM_WORST_FRAME_MS)
    expect(
      zoom.meanFrameMs,
      `the AVERAGE frame during a scripted zoom exceeded ${BUDGET_ZOOM_MEAN_FRAME_MS}ms — the whole gesture got slower, not just the one frame that pays for a mount`,
    ).toBeLessThan(BUDGET_ZOOM_MEAN_FRAME_MS)
  })

  test('Alt+drag on a board frame duplicates the frame', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page)
    const firstFrame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, firstFrame)

    // K2 has not landed until the frame chrome advertises the gesture. Skipping
    // by a named DOM marker (rather than a hand-flipped constant) is what makes
    // this test start asserting the moment the feature exists.
    const hasAltDuplicate = (await page.locator(ALT_DUPLICATE_MARKER).count()) > 0
    test.skip(
      !hasAltDuplicate,
      `K2 has not landed: no board-frame chrome carries ${ALT_DUPLICATE_MARKER}. ` +
        'Add that attribute to the Alt+drag-capable frame chrome and this test starts asserting the duplicate.',
    )

    const framesBefore = frameIdsOnDisk()
    const box = await firstFrame.boundingBox()
    expect(box, 'the board frame has no bounding box').not.toBeNull()

    // Grab the frame's chrome (its title strip sits just above the body), hold
    // Alt for the whole session, and drop it clear of the original.
    const grabX = box!.x + box!.width / 2
    const grabY = box!.y + 6
    await page.keyboard.down('Alt')
    await page.mouse.move(grabX, grabY)
    await page.mouse.down()
    await page.mouse.move(grabX + 80, grabY + 40, { steps: 8 })
    await page.mouse.move(grabX + 320, grabY + 160, { steps: 12 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await page.waitForTimeout(1_500)

    const framesAfter = frameIdsOnDisk()
    expect(
      framesAfter.length,
      'Alt+drag on a board frame did not write exactly one new frame into .studio/boards.json',
    ).toBe(framesBefore.length + 1)
    // The original must survive: Alt+drag duplicates, it does not move.
    for (const id of framesBefore) {
      expect(framesAfter, `Alt+drag removed the original frame ${id} instead of copying it`).toContain(id)
    }
  })

  /**
   * `speed-05` — `STUDIO-SPEED-PLAN.md`'s refusal budget. Before the fix, the
   * whole cost — `refuseStructuralEdit`'s O(1) verdict plus `RefusalDialog`'s
   * cold portal mount — ran inside the SAME main-thread task as the Delete
   * keydown (measured 393 ms, one long task). `presentStructuralRefusal`'s
   * dialog branch now opens `structuralRefusalDialog` inside `startTransition`,
   * so the keydown task ends immediately and React mounts the dialog in its
   * own, interruptible, low-priority render.
   *
   * This case used to target the iOS status bar clock (a `shared-component`
   * refusal). P5-C's detach-and-replay (`instanceOnlyGesture.ts`, OD-7) made
   * that refusal resolve itself — silently, asynchronously, never opening
   * this dialog at all (confirmed empirically: the clock disappears from the
   * canvas ~15s after the keydown, no `[role="alertdialog"]` ever appears).
   * `structuralRefusalTarget` is a `code-placed` refusal instead — a JSX
   * spread lock with no OD-7 remedy — patched into the fixture's own copy by
   * `patchInStructuralRefusalTarget` so the budget keeps measuring what it was
   * built to measure: a refusal with no way to resolve itself.
   */
  test('Delete on a node the source refuses answers with RefusalDialog within budget', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page)
    const firstFrame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, firstFrame)

    // A live board frame mounts a portal fallback AND a hidden bridge iframe
    // until the bridge is ready (never, in this fixture: it has no
    // node_modules). Wait for the one DISPLAYED canvas iframe
    // (`helpers/canvasIframe.ts`) before resolving into it.
    await expect(
      visibleCanvasIframe(firstFrame),
      'the first board frame never showed exactly one canvas iframe',
    ).toHaveCount(1, { timeout: 30_000 })

    const mode = await settleCanvasFrameMode(page, firstFrame, FIXTURE_DIR)
    const contentFrame = canvasContentFrame(firstFrame)
    const target = await structuralRefusalTarget(contentFrame)
    await panIntoView(page, canvasRoot, target, 80)

    // An ordinary element, not an instance — one click selects it directly,
    // no level-opening dance needed.
    await clickInFrame(page, target)
    const rings = selectionRings(page, firstFrame, mode)
    await expect(rings, 'clicking the refusal target drew no selection ring').toHaveCount(1, {
      timeout: 15_000,
    })

    // Delete is a `node`-scope keyboard shortcut and needs the canvas to hold
    // DOM focus, same as the ⌘D test above.
    await canvasRoot.focus()

    await startRefusalTiming(page)
    await page.keyboard.press('Delete')

    await expect(
      page.locator('[role="alertdialog"]'),
      'the refused delete never opened RefusalDialog',
    ).toBeVisible({ timeout: 5_000 })

    const elapsedMs = await readRefusalTiming(page)
    annotate('Delete refusal: keydown → RefusalDialog visible', `${elapsedMs.toFixed(1)}ms`)

    expect(
      elapsedMs,
      `keydown → RefusalDialog visible exceeded ${BUDGET_REFUSAL_DIALOG_MS}ms — speed-05's whole point is that this ` +
        'answer happens outside the keydown task; read docs/archive/plans/STUDIO-SPEED-PLAN.md speed-05 before loosening it',
    ).toBeLessThan(BUDGET_REFUSAL_DIALOG_MS)

    // The dialog answered the RIGHT refusal — `code-placed`'s own remedy
    // (`STRUCTURAL_ACTIONS` in `structuralConstraint.ts`: "Open it in code"),
    // not some other reason a wrong selection would have produced.
    await expect(
      page.getByTestId('constraint-action-jump-to-source'),
      'RefusalDialog opened without the code-placed remedy — the wrong node was likely selected',
    ).toBeVisible()
  })
})

declare global {
  interface Window {
    __studioToastLog?: {
      created: Array<{ kind: string; title: string }>
      observer: MutationObserver
    }
    __studioRefusalTiming?: {
      keydownAt: number
      dialogVisibleAt: number
      observer: MutationObserver | null
    }
  }
}
