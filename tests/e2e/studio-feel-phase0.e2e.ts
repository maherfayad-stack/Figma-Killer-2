import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  SELECTION_RING,
  clickInFrame,
  countSourceOccurrences,
  createFixtureProject,
  decodeNodeSourceLocation,
  readFixtureTrustMeta,
  findSiblingRun,
  firstLeafNode,
  frameForPage,
  nodeChildIds,
  openFixtureBoard,
  panIntoView,
  readNodeSourceFile,
  readToastRecorder,
  recordConsoleErrors,
  removeFixtureProject,
  sourceLineAt,
  startToastRecorder,
  type FixtureProject,
  type RecordedConsoleEvent,
  type SourceNodeLocation,
} from './helpers/studioFixtureProject'

/**
 * The **Phase 0 exit dogfood**, machine-checked.
 *
 * `STUDIO-FIGMA-FEEL-PLAN.md` §8 line 1 makes "Phase 0 exit dogfood passed and
 * recorded" the first condition of the plan's definition of done, and
 * `STATE.md` `meta-14` lists it under "Human action needed" because wave 1
 * cannot close it from a unit test: every claim in it is about what a person
 * sees in a browser after a gesture that writes their `.tsx`.
 *
 * This spec is that dogfood, one `test` per item:
 *
 *   1. ⌘D ×5 inside 300 ms → one collapsed card per message, five siblings on
 *      the canvas, five copies in the file, the last copy selected.  (`Z1`, `K7`)
 *   2. Alt-hover a second element → the measurement overlay shows the real
 *      pixel distance between the two boxes.                          (`K5`)
 *   3. Alt+drag an element to a sibling slot → one "Duplicated" toast, the
 *      original still there, exactly one new element in source.       (`K2`)
 *   4. ⌘G on two siblings writes a wrapper; ⌘⇧G takes it back; ⌘Z undoes each
 *      in one step.                                                   (`K3`)
 *   5. A panel that throws renders its own in-place fallback — not a blank
 *      inspector, not a toast.                                        (`Z2`)
 *   6. The save chip goes Saving… → Saved for a structural write, and offers
 *      Retry (never a toast) when the writeback route fails.          (`Z6`)
 *   7. Zero `console.error` and zero `pageerror` across the whole file, except
 *      a line-by-line justified allowlist.                            (`Z1`–`Z6`)
 *
 * ## What it runs against
 *
 * A throwaway copy of `studio-workspace/test4`, made in `beforeAll` and removed
 * in `afterAll` (`helpers/studioFixtureProject.ts` owns the mechanics and
 * explains why the copy has to live under `studio-workspace/`).
 *
 * **Not `__canonical-fixture`**, and per case the reason is the same one: that
 * project has no `.studio/boards.json`, no committed board and no frame
 * geometry, and its own README says it "is not meant to be opened as a Studio
 * project" — it exists as a parser corpus. Cases 1–6 all need a mounted board
 * frame before they can press a key at all (case 5 needs the inspector, which
 * needs a selection, which needs a frame). `test4` is the tracked corpus every
 * other Studio spec drives. Case 7 is corpus-independent.
 *
 * Every canvas case drives the **`sms`** frame by name rather than `.first()`,
 * because that screen is the only one on this corpus that satisfies all four
 * things these gestures need at once: a run of adjacent, source-addressable,
 * non-form-control leaf siblings long enough to drag one element PAST a
 * neighbour, visible space between them for the measurement case, all of it
 * written in the page's own file rather than in an inlined component, and one
 * run of literal text for the save case. Which frame `.first()` returns is
 * decided by board geometry, not by the spec.
 *
 * ## Reading a failure
 *
 * A failure here is a product defect, not a flaky assertion — these are the
 * gestures a designer makes in the first minute. Cases annotated `test.fail()`
 * name the defect and its owning `STATE.md` entry in a comment directly above,
 * and Playwright fails the run if one of them starts PASSING, so a fix cannot
 * land silently.
 *
 * Nothing here sleeps for a fixed time waiting for a write: every structural
 * gesture is confirmed by POLLING the file on disk and the canvas, so a slow
 * machine reads as slow rather than as broken.
 */

const FIXTURE_NAME = '__e2e-phase0'

/**
 * Case 8's corpus: the smallest project `resolveLiveCapability` answers
 * `{ capable: true }` for. `test4` has no `vite.config.*`, so the auto-promotion
 * rule cannot be observed on it at all — see that fixture's own README.
 */
const LIVE_FIXTURE_SOURCE = '__vite-live-fixture'
const LIVE_FIXTURE_NAME = '__e2e-phase0-vite'

/**
 * The one error case 8 expects, pinned to the exact log line and tied to the
 * reason the fixture cannot avoid it. Same rule as `CONSOLE_ALLOWLIST` below:
 * an entry that stops describing the run starts hiding whatever it matches next.
 */
const LIVE_CONSOLE_ALLOWLIST: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\[useDevServerPrewarm\] could not prewarm the dev server/,
    why:
      'reaching Tier 2 starts the project\'s real dev server, and `__vite-live-fixture` ships a lockfile ' +
      'but no `node_modules` on purpose — committing an installed tree is what .gitignore\'s ' +
      'studio-workspace section exists to prevent. The frame half of this decision is the `test.fail()` ' +
      'case that follows.',
  },
]

/** The board frame every canvas case drives — see this file's header for why. */
const DOGFOOD_PAGE_ID = 'sms'

/**
 * The one run of LITERAL text in `test4`'s `pages/SMS.tsx`. Every other string
 * on this corpus is an i18n expression (`{t.sMS.…}`), which Studio correctly
 * refuses to type over — so this is the only text on the fixture that an
 * inline edit can turn into a real `/admin/api/studio/save` batch.
 */
const LITERAL_TEXT_IN_SMS = '+966 55 333 4444'

/** How long a structural gesture has to reach disk before it counts as not having. */
const WRITE_SETTLE_MS = 30_000

/**
 * The smallest gap the measurement case will accept as a real distance.
 *
 * Not a tolerance — the assertion's tolerance is 1px either way. This is the
 * floor at which "the pill reads the gap" is a claim at all: below it, a pill
 * reading 0 and a pill reading the truth are the same string, so the case
 * would pass on a measurement of nothing. `formatMeasureDistance` rounds to one
 * decimal, so anything at or above this is legible and checkable.
 */
const MIN_MEASURABLE_GAP_PX = 2

let fixture: FixtureProject = { dir: '', ready: false }

/**
 * Every `console.error` and uncaught error the whole file produced, tagged with
 * the test that produced it. Case 7 is the assertion; every other test only
 * feeds it. Safe as file-level state because `playwright.config.ts` runs with
 * `workers: 1` and `fullyParallel: false`.
 */
const consoleEvents: RecordedConsoleEvent[] = []

// A PRISTINE copy per case, not one copy for the file. Every case here writes
// to the user's source, so a shared copy would make case 4 group whatever case
// 3 happened to leave behind — which is exactly what happened while this spec
// was being written: the same ⌘G landed on a different pair on consecutive
// runs and the defect it found appeared and disappeared with it. Each case now
// starts from the same known corpus, so a failure is about the gesture.
test.beforeEach(() => {
  fixture = createFixtureProject('test4', FIXTURE_NAME)
})

test.afterAll(() => {
  removeFixtureProject(fixture)
})

test.describe('Phase 0 exit dogfood', () => {
  // Opening a board is a cold ts-morph parse of the whole project, and several
  // cases then drive multiple source writes with their own resyncs.
  test.setTimeout(300_000)

  test.beforeEach(({ page }, testInfo) => {
    test.skip(
      !fixture.ready,
      'studio-workspace/test4 is not present on disk, so the throwaway fixture could not be made',
    )
    recordConsoleErrors(page, consoleEvents, testInfo.title)
  })

  // Case 7 reads `consoleEvents`, so it must run after everything that fills
  // it. `playwright.config.ts` runs this file with `workers: 1` and
  // `fullyParallel: false`, which makes declaration order execution order.

  // ── 1 ──────────────────────────────────────────────────────────────────────

  /**
   * FIXED by `store-14`, so this is no longer an expected failure. Both
   * defects `verify-3` measured here are closed:
   *
   *   a. **The four later presses are QUEUED, not dropped.** `store-11`'s
   *      guard used to refuse presses 2–5 while the first write was in flight
   *      ("Still writing your last change"), so a five-press burst added ONE
   *      copy. `structuralCommitQueue.ts` parks each of them as a thunk
   *      instead and re-runs it — re-planned against the tree the previous
   *      resync left behind — the moment the wire is clear. The serialization
   *      that closed the original double-write race is intact; only the
   *      refusal is gone.
   *   b. **The last copy is selected.** `store-13` made the save route report
   *      `createdNodeIds`; `store-14` made the route actually forward them (it
   *      never did), so `pendingStructuralOutcome.ts` has something to hand the
   *      resync.
   *
   * The toast assertions are unchanged and are still the tightest part of this
   * case: five successes collapse onto ONE card (Z1), and there should now be
   * ZERO warning cards where there used to be one carrying a ×4 counter.
   */
  test('⌘D five times inside 300ms makes five siblings, five copies in the file, and one collapsed toast', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const smsFrame = await frameForPage(page, canvasRoot, DOGFOOD_PAGE_ID)
    const contentFrame = smsFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const run = await findSiblingRun(contentFrame)
    const targetId = run.childIds[0]!
    const rings = contentFrame.locator(SELECTION_RING)
    await panIntoView(page, canvasRoot, contentFrame.locator(`[data-node-id="${targetId}"]`).first(), 80)
    await selectAndConfirm(page, contentFrame, targetId)

    const location = requireSourceLocation(targetId)
    annotate('duplicating', `${targetId} (in ${location.rel})`)
    const before = readNodeSourceFile(fixture, location)
    const elementLine = sourceLineAt(before, location.line)
    const occurrencesBefore = countSourceOccurrences(before, elementLine)
    const siblingsBefore = await nodeChildIds(contentFrame, run.parentId)

    // `layers.duplicate` is dispatched by the one editor key dispatcher on the
    // parent document (`keys-01`), which needs the canvas to hold DOM focus —
    // where it is after a canvas click in a real session. Clicking inside the
    // iframe focuses the IFRAME, so make it explicit rather than depend on the
    // keyboard bridge.
    await canvasRoot.focus()
    await startToastRecorder(page)

    // Control is held down across all five presses rather than pressed with
    // each one: five keystrokes instead of twenty, which is what keeps the
    // burst inside the window this case is about. It is also what a hand does.
    await page.keyboard.down('Control')
    const startedAt = Date.now()
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('d')
    const burstMs = Date.now() - startedAt
    await page.keyboard.up('Control')
    annotate('⌘D ×5 burst', `${burstMs}ms`)
    expect(
      burstMs,
      'the five presses did not land inside the 300ms window this case is about — the run is too slow to prove anything about a burst',
    ).toBeLessThan(300)

    await expect(
      page.locator('[data-toast-kind="success"]'),
      'five ⌘D presses produced no success toast at all — the duplicate never reached the source',
    ).toHaveCount(1, { timeout: 60_000 })
    // Keep watching after the first write lands: a late sixth card would be
    // exactly the defect this gate exists for, and auto-dismiss cannot hide
    // one — the recorder counts insertions, not what is on screen.
    await page.waitForTimeout(8_000)

    const toasts = await readToastRecorder(page)
    annotate('toast cards', toasts.map((t) => `${t.kind}${t.repeat ? `×${t.repeat}` : ''}`).join(', ') || '(none)')
    annotate('toast titles', toasts.map((t) => t.title).join(' | ') || '(none)')

    // Z1's own done-when, quoted: "rapid ⌘D ×5 on the canvas shows one
    // 'Duplicated' toast and one 'Still writing', never five." Asserted on the
    // NUMBER of cards ever inserted, never on their copy — a rewording must
    // not break this gate, and must not be a way to pass it.
    expect(
      toasts.filter((t) => t.kind === 'success').length,
      'five rapid ⌘D presses stacked more than one success toast — pushToast is not de-duplicating by default (Z1)',
    ).toBe(1)
    expect(
      toasts.filter((t) => t.kind === 'warning').length,
      'the concurrency refusal stacked more than one warning card instead of collapsing onto one with a ×N counter (Z1)',
    ).toBeLessThanOrEqual(1)
    expect(
      toasts.length,
      `five rapid ⌘D presses produced ${toasts.length} toast cards; this gesture is allowed two (one success, one collapsed warning)`,
    ).toBeLessThanOrEqual(2)

    // Five presses, five copies — in the file, which is the document.
    //
    // Soft from here down: these three claims are independent, and a dogfood
    // that stops at the first broken one makes the human run it three times to
    // learn three things. The test still fails — Playwright fails a test that
    // ends with soft errors — it just reports all of them at once.
    const copiesAdded = await settle(
      () => countSourceOccurrences(readNodeSourceFile(fixture, location), elementLine) - occurrencesBefore,
      5,
    )
    annotate('copies added to source', String(copiesAdded))
    expect
      .soft(
        copiesAdded,
        'five ⌘D presses did not write five copies into the .tsx — presses were dropped rather than queued',
      )
      .toBe(5)

    const siblingsNow = await settle(
      () => nodeChildIds(contentFrame, run.parentId).then((ids) => ids.length),
      siblingsBefore.length + 5,
    )
    annotate('siblings on the canvas', `${siblingsNow} (was ${siblingsBefore.length})`)
    expect
      .soft(siblingsNow, 'the canvas does not show five new siblings after five ⌘D presses')
      .toBe(siblingsBefore.length + 5)

    // The last copy is what the eye is on, so it is what the inspector must be
    // pointed at (K7).
    const selectedId = await rings.first().getAttribute('data-canvas-overlay-node-id')
    annotate('selected after the burst', selectedId ?? '(nothing)')
    expect
      .soft(
        siblingsBefore.includes(selectedId ?? ''),
        `after ⌘D ×5 the selection is still on a node that existed before the burst (${selectedId}) — the last copy was never selected (K7)`,
      )
      .toBe(false)
  })

  // ── 2 ──────────────────────────────────────────────────────────────────────

  test('Alt-hovering a second element measures the real distance between the two boxes', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const smsFrame = await frameForPage(page, canvasRoot, DOGFOOD_PAGE_ID)
    const contentFrame = smsFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    // The widest gap in the run: a 0px gap has nothing to be right or wrong
    // about, and two touching boxes would make this case pass on a measurement
    // of nothing.
    const run = await findSiblingRun(contentFrame)
    const widest = run.gapsPx.indexOf(Math.max(...run.gapsPx))
    const selectedId = run.childIds[widest]!
    const hoveredId = run.childIds[widest + 1]!
    expect(
      run.gapsPx[widest] ?? 0,
      'no two siblings on this screen have visible space between them, so there is no distance for the overlay to be right or wrong about',
    ).toBeGreaterThanOrEqual(MIN_MEASURABLE_GAP_PX)
    annotate('measuring between', `${selectedId} and ${hoveredId} (gap ${run.gapsPx[widest]!.toFixed(1)}px)`)

    const selected = contentFrame.locator(`[data-node-id="${selectedId}"]`).first()
    const hovered = contentFrame.locator(`[data-node-id="${hoveredId}"]`).first()
    await panIntoView(page, canvasRoot, selected, 120)
    await selectAndConfirm(page, contentFrame, selectedId)

    // The two boxes as the frame itself sees them — the same viewport-relative
    // space `MeasureLayer` reads through `measureIframeLocalRect` in portal
    // mode, so the numbers below are the ones a ruler would give.
    const [selectedRect, hoveredRect] = await Promise.all([inFrameRect(selected), inFrameRect(hovered)])
    const expected = expectedDistances(selectedRect, hoveredRect)
    annotate('selection rect', JSON.stringify(selectedRect))
    annotate('hovered rect', JSON.stringify(hoveredRect))
    annotate('expected distances', JSON.stringify(expected))
    expect(
      Object.keys(expected).length,
      'the two sibling boxes produced no distance segments at all, so there is nothing for the overlay to be right or wrong about',
    ).toBeGreaterThan(0)

    // Alt is tracked on both the parent document and the frame document
    // (`canvas-18`); pressing it on the page reaches the parent listener.
    await canvasRoot.focus()
    await page.keyboard.down('Alt')
    try {
      const hoveredBox = await hovered.boundingBox()
      expect(hoveredBox, 'the element to Alt-hover has no bounding box').not.toBeNull()
      await page.mouse.move(
        hoveredBox!.x + hoveredBox!.width / 2,
        hoveredBox!.y + hoveredBox!.height / 2,
        { steps: 6 },
      )

      const anyLabel = contentFrame.locator('[data-canvas-measure-label][data-measure-kind="distance"]')
      await expect(
        anyLabel.first(),
        'Alt-hovering a second element drew no measurement label — the K5 overlay never appeared',
      ).toBeVisible({ timeout: 15_000 })

      for (const [side, distance] of Object.entries(expected)) {
        const label = contentFrame.locator(
          `[data-canvas-measure-label][data-measure-kind="distance"][data-side="${side}"]`,
        )
        await expect(
          label,
          `the measurement overlay drew no "${side}" distance between the two boxes`,
        ).toBeVisible({ timeout: 10_000 })
        const labelText = (await label.textContent())?.trim() ?? ''
        const shown = Number(labelText)
        annotate(`measured ${side}`, `${labelText} (expected ${distance.toFixed(1)})`)
        expect(
          Number.isFinite(shown),
          `the "${side}" measurement pill does not read as a number ("${labelText}")`,
        ).toBe(true)
        // 1px: the pill rounds to one decimal and the rects are sub-pixel.
        expect(
          Math.abs(shown - distance),
          `the "${side}" measurement pill reads ${shown}px but the two boxes are ${distance.toFixed(1)}px apart on that edge`,
        ).toBeLessThanOrEqual(1)
      }
    } finally {
      await page.keyboard.up('Alt')
    }

    // Releasing Alt ends the gesture — the overlay is a gesture, not a mode.
    await expect(
      contentFrame.locator('[data-canvas-measure-label][data-measure-kind="distance"]').first(),
      'the measurement overlay stayed on screen after Alt was released',
    ).toBeHidden({ timeout: 10_000 })
  })

  // ── 3 ──────────────────────────────────────────────────────────────────────

  test('Alt+drag an element to a sibling slot copies it once and leaves the original alone', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const smsFrame = await frameForPage(page, canvasRoot, DOGFOOD_PAGE_ID)
    const contentFrame = smsFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    // Drag the first sibling PAST its neighbour onto the third, not onto the
    // one it already precedes: dropping an element where it already is has no
    // new position to resolve, so a no-op there would prove nothing about K2.
    const run = await findSiblingRun(contentFrame, { minCount: 3 })
    const sourceId = run.childIds[0]!
    const destinationId = run.childIds[2]!
    const source = contentFrame.locator(`[data-node-id="${sourceId}"]`).first()
    const destination = contentFrame.locator(`[data-node-id="${destinationId}"]`).first()
    await panIntoView(page, canvasRoot, source, 120)
    await selectAndConfirm(page, contentFrame, sourceId)

    const location = requireSourceLocation(sourceId)
    annotate('dragging', `${sourceId} onto ${destinationId} (in ${location.rel})`)
    const before = readNodeSourceFile(fixture, location)
    const elementLine = sourceLineAt(before, location.line)
    const occurrencesBefore = countSourceOccurrences(before, elementLine)
    const allNodes = contentFrame.locator('[data-node-id]')
    const nodesBefore = await allNodes.count()
    const inContainer = contentFrame.locator(`[data-node-id="${run.parentId}"] [data-node-id]`)
    const inContainerBefore = await inContainer.count()

    await startToastRecorder(page)

    const [from, to] = await Promise.all([source.boundingBox(), destination.boundingBox()])
    expect(from, 'the dragged element has no bounding box').not.toBeNull()
    expect(to, 'the drop target has no bounding box').not.toBeNull()

    // Alt is read at `pointerdown` and live thereafter (`canvas-19`), so hold it
    // for the whole session: the drag is then a duplicate-to plan rather than a
    // move.
    let ghost: DragChrome | undefined
    await page.keyboard.down('Alt')
    try {
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
      await page.mouse.down()
      await page.mouse.move(from!.x + from!.width / 2 + 12, from!.y + from!.height / 2 + 12, { steps: 4 })
      // The leading edge, not the middle: the middle of an element is "into
      // it" to every drop resolver, and this case is about landing in a
      // SIBLING SLOT. 2px inside the edge keeps the pointer over the element
      // whose slot is meant.
      await page.mouse.move(to!.x + 2, to!.y + to!.height / 2, { steps: 12 })
      await page.waitForTimeout(400)
      // Read the gesture's own chrome while the pointer is still DOWN. This is
      // K2's visible promise ("the ghost shows a `+` badge while Alt is held")
      // and it is also the difference between "the drop was refused" and "no
      // drag ever started" — two completely different reports.
      ghost = await readDragChrome(page)
      await page.mouse.up()
    } finally {
      await page.keyboard.up('Alt')
    }
    if (!ghost) {
      throw new Error('the Alt+drag block never read the drag chrome, so the gesture did not complete')
    }
    annotate('drag chrome while Alt was held', JSON.stringify(ghost))

    expect(
      ghost.present,
      'pressing an element and moving with Alt held never opened a drag session — no ghost was painted, so nothing was dragged',
    ).toBe(true)
    expect(
      ghost.duplicating,
      'the drag ghost did not advertise a duplicate while Alt was held — Alt+drag was a MOVE (K2)',
    ).toBe('true')
    expect(
      ghost.refusal,
      `the drop was refused mid-gesture (${ghost.refusal}) — Alt+drag onto a plain sibling slot must be allowed`,
    ).toBeNull()

    await expect(
      page.locator('[data-toast-kind="success"]'),
      'Alt+drag onto a sibling produced no success toast — the copy never reached the source',
    ).toHaveCount(1, { timeout: 60_000 })
    await page.waitForTimeout(5_000)

    const toasts = await readToastRecorder(page)
    annotate('toast cards', toasts.map((t) => `${t.kind}:${t.title}`).join(' | ') || '(none)')
    expect(
      toasts.filter((t) => t.kind === 'success').length,
      'an Alt+drag duplicate pushed more than one success toast',
    ).toBe(1)

    await expect
      .poll(
        () => countSourceOccurrences(readNodeSourceFile(fixture, location), elementLine) - occurrencesBefore,
        {
          message:
            'Alt+drag onto a sibling did not write exactly one copy into the .tsx — the original must survive and the copy must be the only addition',
          timeout: WRITE_SETTLE_MS,
        },
      )
      .toBe(1)
    // The copy exists on the canvas, exactly once.
    //
    // Counted across the whole frame rather than inside the container under the
    // pointer, and that is deliberate. Which SLOT a drop resolves to is
    // `previewStructuralMove`'s contract, not K2's — and on this corpus, where
    // the siblings are inline `<span>`s 3.9px apart, the copy was observed
    // landing outside the container the pointer was over. That is worth a
    // drag-owner's look (`canvas-19`), but it is a different feature's claim,
    // and asserting it here would make the Alt+drag gate red on somebody else's
    // ambiguity. The container count is annotated so the next reader sees the
    // same thing without having to instrument it again.
    await expect
      .poll(() => allNodes.count(), {
        message: 'Alt+drag did not add exactly one element to the canvas',
        timeout: WRITE_SETTLE_MS,
      })
      .toBe(nodesBefore + 1)
    annotate(
      'elements inside the container under the pointer',
      `${await inContainer.count()} (was ${inContainerBefore})`,
    )

    // "Original unmoved": its own source text is still where it was, byte for
    // byte, on the line it started on.
    const after = readNodeSourceFile(fixture, location)
    expect(
      sourceLineAt(after, location.line).trim(),
      'Alt+drag moved the original instead of copying it — its source line changed',
    ).toBe(elementLine.trim())
  })

  // ── 4 ──────────────────────────────────────────────────────────────────────

  /**
   * GREEN as of wave 3, and it took both halves. `verify-3` recorded three
   * defects here; each was owned by a different layer and each is now closed:
   *
   *   a. **The wrapper tag was always `<div>`**, so grouping two inline
   *      `<span>`s inside a `<p>` wrote `<div>` into phrasing content and
   *      React reported a hydration error in the user's own app. Closed by
   *      `struct-11`: the tag follows the HTML content model
   *      (`@core/utils/htmlContentModel`), so this run groups into a `<span>`,
   *      asserted below. Case 7's console gate was red for exactly those two
   *      React errors and is an ordinary pass because of this.
   *   b. **The new wrapper was not selected.** Closed: `store-13` made the
   *      batch report created node ids and `store-14` made `/save` forward
   *      them, so ⌘G ends with the group selected. It occupies the first
   *      sibling's old `line:col`, which is why the assertion below compares
   *      its TAG rather than its id (`meta-16` landmine 7).
   *   c. **A second ⌘G in the same session wrote nothing.** Closed: that was
   *      `store-11`'s in-flight refusal; gestures now queue
   *      (`structuralCommitQueue.ts`) instead of being dropped.
   *   — and the ⌘Z claim, unreachable before (c) was fixed, holds too: a group
   *      written to source records a patch-free history entry whose inverse is
   *      an `ungroup`, and one ⌘Z posts it.
   */
  test('⌘G groups two siblings into real source, ⌘⇧G takes it back, and ⌘Z undoes each in one step', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const smsFrame = await frameForPage(page, canvasRoot, DOGFOOD_PAGE_ID)
    const contentFrame = smsFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const run = await findSiblingRun(contentFrame)
    const firstId = run.childIds[0]!
    const secondId = run.childIds[1]!
    await panIntoView(page, canvasRoot, contentFrame.locator(`[data-node-id="${firstId}"]`).first(), 120)

    const location = requireSourceLocation(firstId)
    annotate('grouping', `${firstId} + ${secondId} (in ${location.rel})`)
    const before = readNodeSourceFile(fixture, location)
    const siblingsBefore = await nodeChildIds(contentFrame, run.parentId)

    await selectAndConfirm(page, contentFrame, firstId)
    await shiftClick(page, contentFrame.locator(`[data-node-id="${secondId}"]`).first())
    await expect(
      contentFrame.locator(SELECTION_RING),
      'Shift+click did not extend the selection to two elements, so ⌘G would be a wrap, not a group',
    ).toHaveCount(2, { timeout: 15_000 })

    await canvasRoot.focus()
    await page.keyboard.press('Control+g')
    await expect(
      page.locator('[data-toast-kind="success"]'),
      '⌘G on two contiguous siblings produced no success toast — nothing was written',
    ).toHaveCount(1, { timeout: 60_000 })

    // Soft from here down, for the reason case 1 gives: one run, every broken
    // claim, rather than one claim per run.
    const groupedChildren = await settle(
      () => nodeChildIds(contentFrame, run.parentId).then((ids) => ids.length),
      siblingsBefore.length - 1,
    )
    annotate('children after ⌘G', `${groupedChildren} (was ${siblingsBefore.length})`)
    expect
      .soft(groupedChildren, '⌘G did not replace the two selected siblings with one wrapper in their parent')
      .toBe(siblingsBefore.length - 1)

    const grouped = readNodeSourceFile(fixture, location)
    annotate('source changed by ⌘G', String(grouped !== before))
    expect
      .soft(grouped, '⌘G did not change the .tsx — a group is a source write, not a canvas-only regrouping')
      .not.toBe(before)

    // `struct-11` — the container's TAG. This run sits inside a `<span>`
    // inside a `<p>`, i.e. phrasing content, where a `<div>` is invalid HTML
    // and React says so twice in the user's own console. The wrapper takes the
    // first member's old line, so its own tag is the first thing on it.
    const wrapperLine = sourceLineAt(grouped, location.line).trim()
    annotate('the tag ⌘G wrote', wrapperLine)
    expect
      .soft(
        wrapperLine,
        'the container ⌘G wrote into phrasing content is not a <span> — a <div> here is markup the app reports as a hydration error',
      )
      .toMatch(/^<span>/)

    // The group itself is the selection, so ⌘⇧G is the very next thing a hand
    // can press. Compared by TAG, not by id: the wrapper legitimately occupies
    // the first sibling's old `line:col`, so "is it a member of
    // `siblingsBefore`" is undecidable (`meta-16` landmine 7). What is
    // decidable is that the selected node is the container that was just
    // written — the only `<span>` with no attributes on that line.
    const wrapperId = await contentFrame
      .locator(SELECTION_RING)
      .first()
      .getAttribute('data-canvas-overlay-node-id')
    annotate('selected after ⌘G', wrapperId ?? '(nothing)')
    annotate('siblings before ⌘G', siblingsBefore.join(', '))
    expect
      .soft(wrapperId, '⌘G left nothing selected, so the group it just made is not what the inspector is pointed at')
      .not.toBeNull()
    const selectedLocation = wrapperId === null ? null : decodeNodeSourceLocation(wrapperId)
    expect
      .soft(
        selectedLocation === null ? '(no source location)' : sourceLineAt(grouped, selectedLocation.line).trim(),
        `⌘G left the selection on something other than the container it just wrote (${wrapperId})`,
      )
      .toMatch(/^<span>/)

    await canvasRoot.focus()
    await page.keyboard.press('Control+Shift+g')
    const ungrouped = await settle(() => readNodeSourceFile(fixture, location), before)
    annotate('source restored by ⌘⇧G', String(ungrouped === before))
    expect
      .soft(
        ungrouped,
        '⌘⇧G did not take the file back to exactly what it was before ⌘G — group/ungroup is not a round trip',
      )
      .toBe(before)

    // Now the same pair again, this time undone with ⌘Z rather than ⌘⇧G.
    const runAgain = await findSiblingRun(contentFrame)
    await panIntoView(
      page,
      canvasRoot,
      contentFrame.locator(`[data-node-id="${runAgain.childIds[0]!}"]`).first(),
      120,
    )
    await selectAndConfirm(page, contentFrame, runAgain.childIds[0]!)
    await shiftClick(page, contentFrame.locator(`[data-node-id="${runAgain.childIds[1]!}"]`).first())
    await expect(contentFrame.locator(SELECTION_RING)).toHaveCount(2, { timeout: 15_000 })

    await canvasRoot.focus()
    await startToastRecorder(page)
    await page.keyboard.press('Control+g')
    const regrouped = await settle(() => readNodeSourceFile(fixture, location) !== before, true)
    const regroupToasts = await readToastRecorder(page)
    annotate('second ⌘G wrote something for ⌘Z to undo', String(regrouped))
    annotate(
      'what the second ⌘G said',
      regroupToasts.map((t) => `${t.kind}:${t.title}`).join(' | ') || '(nothing)',
    )
    expect
      .soft(regrouped, 'the second ⌘G did not write anything, so there is nothing for ⌘Z to undo')
      .toBe(true)

    // Wait for the BOARD to catch up, not just the file. A source write's
    // history entry is pushed by the resync drain (`applyStructuralWriteOutcome`,
    // called immediately after `patchPages`) — the same drain that moves the
    // selection onto the new wrapper. Two rings means the shift-click selection
    // is still standing and the resync has not landed; pressing ⌘Z there would
    // find an empty undo stack and do nothing, which reads as "undo is broken"
    // rather than "the spec was early".
    await expect(
      contentFrame.locator(SELECTION_RING),
      'the second ⌘G never put the selection on its new wrapper, so its undo entry had not been recorded either',
    ).toHaveCount(1, { timeout: 60_000 })

    await page.keyboard.press('Control+z')
    const undone = await settle(() => readNodeSourceFile(fixture, location), before)
    annotate('source restored by one ⌘Z', String(undone === before))
    expect
      .soft(
        undone,
        'ONE ⌘Z after ⌘G did not take the .tsx back to what it was — a group written to source has no undo',
      )
      .toBe(before)
  })

  // ── 5 ──────────────────────────────────────────────────────────────────────

  /**
   * FIXED by `panel-40`. `Z2` says every seam except `admin-shell` "renders an
   * in-place fallback ... instead of the toast", and `store-12` shipped that
   * behaviour on the boundary primitive — but the inspector had no boundary of
   * its own, so the nearest one was `AdminCanvasLayout`'s `LazyChunkBoundary
   * location="site-editor-body"`, wrapping the canvas and every panel
   * together. This case measured the consequence: the fallback rendered, and
   * `canvas-root` and `canvas-notch` were GONE with it.
   *
   * `PanelBoundary` (`src/admin/pages/site/ui/PanelBoundary/`) is now mounted
   * per panel, per inspector tab and per Design-tab section, and it is also
   * where `PanelCrashProbe` lives — so `detail` names the boundary's own
   * `location` (`panel:design`) rather than a bare panel word.
   */
  test('a panel that throws renders its own in-place fallback, and nothing else moves', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const smsFrame = await frameForPage(page, canvasRoot, DOGFOOD_PAGE_ID)
    const contentFrame = smsFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const target = await firstLeafNode(contentFrame)
    await panIntoView(page, canvasRoot, target, 80)
    await clickInFrame(page, target)

    const inspector = page.locator('[data-inspector-tab="design"]:not([hidden])')
    await expect(
      inspector,
      'nothing opened an inspector Design tab, so there is no panel to crash',
    ).toBeVisible({ timeout: 30_000 })

    await startToastRecorder(page)

    // `PanelCrashProbe` is the dev-only seam that makes a panel throw on
    // purpose; it is erased from a production build at its mount site. See its
    // header for both gates.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('studio:panel-crash-probe', { detail: 'panel:design' }))
    })

    const fallback = page.locator('[role="alert"][data-error-location]')
    await expect(
      fallback,
      'a panel that threw rendered no in-place ErrorBoundary fallback anywhere',
    ).toBeVisible({ timeout: 15_000 })
    annotate('fallback location', (await fallback.first().getAttribute('data-error-location')) ?? '(none)')

    // The whole point of an in-place fallback: the rest of the editor is still
    // there. A boundary that swallows the canvas has not rendered "in place".
    await expect(
      canvasRoot,
      'a panel that threw took the canvas down with it — the fallback replaced the editor body rather than the panel',
    ).toBeVisible()
    await expect(
      page.getByTestId('canvas-notch'),
      'a panel that threw removed the canvas notch — more than the panel was replaced',
    ).toBeVisible()

    // Z2's other half: a boundary that is not `admin-shell` never toasts.
    await page.waitForTimeout(3_000)
    const toasts = await readToastRecorder(page)
    annotate('toasts after the crash', toasts.map((t) => `${t.kind}:${t.title}`).join(' | ') || '(none)')
    expect(
      toasts.filter((t) => t.kind === 'error').length,
      'a panel crash pushed an error toast — Z2 makes every boundary but admin-shell silent',
    ).toBe(0)

    // The fallback offers its own way out, in place.
    await expect(
      fallback.first().getByRole('button', { name: /reload this panel/i }),
      'the in-place fallback offers no way to recover the panel',
    ).toBeVisible()
  })

  // ── 6 ──────────────────────────────────────────────────────────────────────

  test('the save chip reports a structural write, and offers Retry — never a toast — when the writeback fails', async ({
    page,
  }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const smsFrame = await frameForPage(page, canvasRoot, DOGFOOD_PAGE_ID)
    const contentFrame = smsFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const run = await findSiblingRun(contentFrame)
    const targetId = run.childIds[0]!
    await panIntoView(page, canvasRoot, contentFrame.locator(`[data-node-id="${targetId}"]`).first(), 80)
    await selectAndConfirm(page, contentFrame, targetId)

    // ── saving → saved, for one structural write ────────────────────────────
    // Sampled with a MutationObserver rather than polled: a structural commit
    // on this corpus takes tens of milliseconds, so a poll would legitimately
    // miss the "Saving…" this case exists to prove was shown.
    await startSaveStatusRecorder(page)
    await canvasRoot.focus()
    await page.keyboard.press('Control+d')
    await expect(page.locator('[data-toast-kind="success"]')).toHaveCount(1, { timeout: 60_000 })
    await expect
      .poll(() => peekSaveStatusRecorder(page).then((states) => states[states.length - 1] ?? null), {
        message: 'the save chip never settled on "Saved" after a structural write landed',
        timeout: 60_000,
      })
      .toBe('saved')

    const states = await readSaveStatusRecorder(page)
    annotate('save chip states during a structural write', states.join(' → ') || '(none)')
    expect(
      states,
      'the save chip never said "Saving…" while a structural write was on the wire — Z6 exists so that write is visible',
    ).toContain('saving')
    expect(
      states[states.length - 1],
      'the save chip did not end on "Saved" after a structural write landed',
    ).toBe('saved')

    // ── the writeback route fails → Retry, and no toast ─────────────────────
    let writebackAttempts = 0
    await page.route('**/admin/api/studio/save', (route) => {
      writebackAttempts += 1
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the writeback route was made to fail by studio-feel-phase0.e2e.ts' }),
      })
    })
    await startToastRecorder(page)

    // A value edit, because only a value edit produces a `/admin/api/studio/save`
    // batch (`fsCodemodAdapter.saveSite` posts nothing when the batch is empty).
    // Inline text editing is the user's own way to make one.
    const textNode = contentFrame.getByText(LITERAL_TEXT_IN_SMS, { exact: true }).first()
    await expect(
      textNode,
      `the fixture's SMS screen no longer renders the literal text "${LITERAL_TEXT_IN_SMS}", so there is nothing here to inline-edit`,
    ).toBeVisible({ timeout: 15_000 })
    await panIntoView(page, canvasRoot, textNode, 80)
    const textBox = await textNode.boundingBox()
    expect(textBox, 'the literal text node has no bounding box').not.toBeNull()
    await page.mouse.dblclick(textBox!.x + textBox!.width / 2, textBox!.y + textBox!.height / 2)

    // A separate, earlier claim than "the save failed": double-clicking a
    // literal text node must OPEN inline editing (`NodeRenderer`'s
    // `inlineEditBinding`). Without this the case's real failure — "no save
    // batch was produced" — would read as a Z6 defect when the truth is that
    // nothing was ever typed.
    await expect(
      contentFrame.locator('[contenteditable]'),
      'double-clicking a literal text node did not open inline editing, so no value edit could be made',
    ).toHaveCount(1, { timeout: 15_000 })
    await page.keyboard.type('!')
    await page.keyboard.press('Control+Enter')

    // Proved separately from the chip, because the two failures read very
    // differently: no request at all means the inline edit produced no save
    // batch (a fixture problem), while requests with no chip means Z6's ladder
    // never gave up (the defect this case is about).
    await expect
      .poll(() => writebackAttempts, {
        message:
          'the inline text edit produced no POST to /admin/api/studio/save at all, so the writeback was never made to fail',
        timeout: 30_000,
      })
      .toBeGreaterThan(0)

    // 2s autosave debounce, then the three-rung ladder (2s/4s/8s) before the
    // chip is allowed to give up — `SAVE_RETRY_BACKOFF_MS`.
    const stuck = page.locator('[data-save-status="error"]')
    await expect(
      stuck,
      'the save chip never reached "Unsaved — retry" after every writeback attempt returned 500',
    ).toBeVisible({ timeout: 90_000 })
    annotate('failed writeback attempts before the chip gave up', String(writebackAttempts))
    await expect(stuck, 'the stuck save chip does not offer a retry').toHaveText(/Unsaved — retry/)

    const failureToasts = await readToastRecorder(page)
    annotate(
      'toasts during the failed saves',
      failureToasts.map((t) => `${t.kind}:${t.title}`).join(' | ') || '(none)',
    )
    expect(
      failureToasts.filter((t) => t.kind === 'error' || t.kind === 'warning').length,
      'a failing save pushed a toast — Z6 replaced that with the chip precisely because a restarting server produces a dozen of them',
    ).toBe(0)

    // Clicking Retry with the route restored lands the edit.
    await page.unroute('**/admin/api/studio/save')
    await stuck.click()
    await expect(
      page.locator('[data-save-status="saved"]'),
      'clicking Retry with the writeback route healthy again did not land the edit',
    ).toBeVisible({ timeout: 60_000 })
  })

  // ── 7 ──────────────────────────────────────────────────────────────────────

  /**
   * GREEN since `struct-11`. It was red for exactly one reason: React's two
   * complaints about case 4's ⌘G — "In HTML, <div> cannot be a descendant of
   * <p>" and "<p> cannot contain a nested <div>". They were never test noise;
   * they were React reporting that Studio had just written invalid HTML into
   * the user's file. Allowlisting them would have been precisely the "detect
   * the errors I did not see" failure this plan is named after, so they stayed
   * unexplained and this case stayed `test.fail()` until the wrapper tag was
   * fixed at the source. It is fixed (case 4 asserts the tag), the two errors
   * are gone, and the `test.fail()` is gone with them — leaving it would make
   * Playwright fail the run for passing.
   *
   * This case is now the file's backstop: any NEW error, from any case, is a
   * real failure here. The allowlist is not the place to answer one.
   */
  test('the whole dogfood produced no unexplained console errors', async () => {
    const unexplained = consoleEvents.filter(
      (event) => !CONSOLE_ALLOWLIST.some((entry) => entry.pattern.test(event.text)),
    )
    annotate('console/pageerror events recorded', String(consoleEvents.length))
    annotate('matched by the allowlist', String(consoleEvents.length - unexplained.length))

    expect(
      unexplained.map((event) => `${event.test} — [${event.source}] ${event.text}`),
      'the editor logged an error nothing in this file expects. Read it before allowlisting it: ' +
        'every entry in CONSOLE_ALLOWLIST names the case that causes it and why that case cannot avoid it. ' +
        'An error with no such cause is the "detect the errors I did not see" defect this plan is named after.',
    ).toEqual([])

    // An allowlist entry nothing produces is drift: it stops describing the run
    // and starts hiding whatever it happens to match next.
    if (consoleEvents.length > 0) {
      const unused = CONSOLE_ALLOWLIST.filter(
        (entry) => !consoleEvents.some((event) => entry.pattern.test(event.text)),
      )
      expect(
        unused.map((entry) => `${String(entry.pattern)} — ${entry.why}`),
        'a CONSOLE_ALLOWLIST entry matched nothing in this run. Either the case that used to produce it ' +
          'no longer does (delete the entry) or the case stopped running (fix the case).',
      ).toEqual([])
    }
  })

  // ── 8 ──────────────────────────────────────────────────────────────────────

  /**
   * §6 decision 2 — **a Vite project with a lockfile is promoted to
   * `run-project` on FIRST OPEN, once ever, with a visible Undo.**
   *
   * This is the only place in Studio where the trust tier moves without a human
   * clicking anything, which makes it the only place where losing a gate is
   * SILENT: a build that stopped checking "is it Vite", or stopped writing the
   * once-only latch, or stopped stopping the dev server on Undo, looks exactly
   * like this one on screen. So the three things asserted here are all
   * refusals, not features:
   *
   *   a. the promotion happens AND says so — a Tier-2 promotion the user is
   *      never told about is the override without the thing that justifies it;
   *   b. Undo writes `static` back, and `trustAutoPromotedAt` STAYS SET — the
   *      latch is what stops a project whose owner said no from being
   *      auto-promoted again on the next open;
   *   c. re-opening the project after the Undo does NOT promote it again and
   *      does NOT show the notice. (b) is the byte on disk; (c) is the
   *      behaviour that byte exists to produce, and only (c) fails if the
   *      client stops reading the latch.
   *
   * ## Why this case runs LAST, and on its own fixture
   *
   * It is the only case in this file that does not drive `test4`: auto-promotion
   * is a property of the PROJECT, and `test4` has no `vite.config.*`, so nothing
   * about it can be observed there. `studio-workspace/__vite-live-fixture` is
   * the smallest project `resolveLiveCapability` answers `{ capable: true }` for
   * — its README lists each of its five files against the condition it
   * satisfies.
   *
   * It is declared after case 7 on purpose. Reaching Tier 2 makes
   * `useDevServerPrewarm` try to start the project's real dev server, and the
   * fixture deliberately ships no `node_modules` (committing one is what
   * `.gitignore`'s studio-workspace section exists to prevent), so that attempt
   * fails and logs. Feeding that into case 7's file-wide console budget would
   * mean allowlisting a real error there for a reason that has nothing to do
   * with the dogfood; instead this case carries its own recorder and its own
   * one-entry allowlist, pinned to that exact message.
   */
  test('a Vite project with a lockfile promotes itself to Tier 2 on first open, and Undo takes it back for good', async ({
    page,
  }) => {
    const live = createFixtureProject(LIVE_FIXTURE_SOURCE, LIVE_FIXTURE_NAME)
    test.skip(
      !live.ready,
      `studio-workspace/${LIVE_FIXTURE_SOURCE} is not present on disk, so the throwaway copy could not be made`,
    )

    const liveConsole: RecordedConsoleEvent[] = []
    recordConsoleErrors(page, liveConsole, 'auto-promote')

    try {
      await startToastRecorder(page)
      await openFixtureBoard(page, live, { autoSave: false })

      // (a) The promotion, and the notice that makes it defensible.
      const notice = page.getByTestId('live-auto-promote-notice')
      await expect(
        notice,
        'a Vite project with a lockfile opened without announcing that Studio promoted it to Tier 2',
      ).toBeVisible({ timeout: 60_000 })
      await expect(notice).toContainText('Running your app live')

      await settle(() => readFixtureTrustMeta(live).trust, 'run-project')
      const promoted = readFixtureTrustMeta(live)
      annotate('trust after first open', JSON.stringify(promoted))
      expect(promoted.trust, 'first open did not write run-project into .studio/meta.json').toBe('run-project')
      expect(promoted.trustAutoPromoted, 'the promotion did not record that its ORIGIN was Studio').toBe(true)
      expect(
        typeof promoted.trustAutoPromotedAt,
        'the once-only latch (trustAutoPromotedAt) was never written',
      ).toBe('number')

      // The pill is the permanent, session-independent statement of the same
      // fact — `sec-10`'s "revocable, not just undoable".
      await expect(page.getByTestId('live-runtime-pill')).toHaveAttribute('data-runtime', 'live')

      // (b) Undo — back to static, latch deliberately left set.
      await page.getByTestId('live-auto-promote-undo').click()
      const undone = await settle(() => readFixtureTrustMeta(live).trust, 'static')
      annotate('trust after Undo', JSON.stringify(readFixtureTrustMeta(live)))
      expect(undone, 'Undo did not put the project back to static').toBe('static')
      expect(
        readFixtureTrustMeta(live).trustAutoPromotedAt,
        'Undo cleared the once-only latch, so the next open would promote this project all over again — ' +
          'the latch is the whole reason the override is bounded',
      ).toBe(promoted.trustAutoPromotedAt)

      // Read the toast log BEFORE the reload — the recorder lives in the page,
      // and a reload takes it with it.
      //
      // Zero error toasts across promote + undo. An automatic promotion the
      // user did not ask for must not be able to put an error in front of them;
      // `LiveAutoPromoteNotice` logs its failures instead, deliberately.
      const toasts = await readToastRecorder(page)
      annotate('toast cards during promote + undo', JSON.stringify(toasts.map((t) => `${t.kind}:${t.title}`)))
      expect(
        toasts.filter((t) => t.kind === 'error').map((t) => t.title),
        'the automatic promotion path put an error toast in front of the user',
      ).toEqual([])

      // (c) The latch as BEHAVIOUR, not just as a byte: open it again.
      await page.reload()
      await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('live-runtime-pill')).toHaveAttribute('data-runtime', 'static', {
        timeout: 30_000,
      })
      await expect(
        page.getByTestId('live-auto-promote-notice'),
        'the project was auto-promoted a SECOND time — the latch is not being read',
      ).toBeHidden()
      expect(
        readFixtureTrustMeta(live).trust,
        'a second open re-promoted a project whose owner clicked Undo',
      ).toBe('static')

      const unexplained = liveConsole.filter(
        (event) => !LIVE_CONSOLE_ALLOWLIST.some((entry) => entry.pattern.test(event.text)),
      )
      expect(
        unexplained.map((event) => `[${event.source}] ${event.text}`),
        'the auto-promotion flow logged an error this case does not expect',
      ).toEqual([])
    } finally {
      removeFixtureProject(live)
    }
  })

  /**
   * The LIVE FRAME half of §6 decision 2, which this machine cannot satisfy.
   *
   * Tier 2 means the frames are rendered by the project's OWN dev server
   * (`server/handlers/studio/devServer.ts` + `server/liveOrigin.ts`), and a dev
   * server needs an installed dependency tree. `__vite-live-fixture` ships a
   * lockfile and no `node_modules` on purpose — committing an installed tree
   * into this repository is precisely what `.gitignore`'s studio-workspace
   * section exists to prevent ("the missing rule cost 140,894 committed
   * lines"), and the fixture's README says so.
   *
   * Marked `test.fail()` rather than skipped: a skip is invisible in a summary,
   * and Playwright fails the run if this starts PASSING — so whoever gives this
   * fixture a real install (or points the case at a project that has one) finds
   * out here rather than discovering later that nothing checked it.
   */
  test('a promoted project renders its frames from its own dev server', async ({ page }) => {
    test.fail()
    const live = createFixtureProject(LIVE_FIXTURE_SOURCE, LIVE_FIXTURE_NAME)
    test.skip(!live.ready, `studio-workspace/${LIVE_FIXTURE_SOURCE} is not present on disk`)
    try {
      await openFixtureBoard(page, live, { autoSave: false })
      await expect(page.getByTestId('live-auto-promote-notice')).toBeVisible({ timeout: 60_000 })
      // A live frame is a different element from a design-mode canvas frame:
      // it is the project's own document, proxied through `/p/<projectKey>/`.
      await expect(
        page.locator('iframe[data-live-frame="true"]').first(),
        'no live frame mounted — the dev server never came up (this fixture has no node_modules)',
      ).toBeVisible({ timeout: 60_000 })
    } finally {
      removeFixtureProject(live)
    }
  })
})

/**
 * The only console errors this file is allowed to produce, each tied to the
 * case that deliberately causes it.
 *
 * Nothing here is "noise we tolerate": every entry is a log a case ASKS the
 * product to write, and removing the case would remove the log. Each pattern is
 * pinned to something this spec itself injected — the probe's name, or the
 * message this file puts in its own 500 envelope — so an entry cannot quietly
 * grow to cover a real failure. An error matching none of these is a genuine
 * defect in something the dogfood touched.
 */
const CONSOLE_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    // Case 5 throws inside a panel on purpose. `ErrorBoundary.componentDidCatch`
    // logs the chain under `[error-boundary:<location>]` by design (CLAUDE.md's
    // `[<module>]` prefix rule) — that log IS the boundary working.
    pattern: /^\[error-boundary:[\s\S]*PanelCrashProbe/,
    why: 'case 5 throws inside a panel on purpose; the boundary logs what it caught',
  },
  {
    // React's own report of the SAME throw, through the root `onCaughtError`
    // callback `src/admin/main.tsx` installs. It fires twice (once for the
    // error, once for the component stack) and both name the probe.
    pattern: /^\[react-root:caught\][\s\S]*PanelCrashProbe/,
    why: 'case 5 — React re-reports the probe throw through the root error callbacks',
  },
  {
    // Case 6 fails `/admin/api/studio/save` with `page.route`. Chromium logs
    // every non-2xx response it sees, before any application code runs; nothing
    // in Studio can suppress it.
    pattern: /^Failed to load resource: the server responded with a status of 500/,
    why: 'case 6 intercepts the writeback route with a 500; this is Chromium reporting the response',
  },
  {
    // The first save the interception failed, and then each rung of the retry
    // ladder. Matched on the message THIS FILE injected into the 500 envelope,
    // so a save that failed for any other reason is still unexplained.
    pattern:
      /^\[persistence\] (Auto-save|Automatic save retry) failed:[\s\S]*the writeback route was made to fail by studio-feel-phase0\.e2e\.ts/,
    why: 'case 6 — the Z6 ladder logs each failed save instead of toasting it, which is the point of Z6',
  },
]

// ─── Local helpers ───────────────────────────────────────────────────────────

/** Records a measurement on the test AND prints it — same convention as `studio-board-perf.e2e.ts`. */
function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'dogfood', description: `${label}: ${value}` })
  console.log(`[phase0] ${label}: ${value}`)
}

/**
 * Read `value` until it equals `want`, then return it — returning whatever it
 * last was if it never does.
 *
 * The passing direction has to be fast (a structural write lands in tens of
 * milliseconds and a fixed sleep would make this file minutes longer), and the
 * failing direction has to be BOUNDED and non-throwing, so the caller can
 * report it as one soft failure among several instead of aborting the case at
 * the first broken claim. `expect.poll` gives the first half and not the
 * second.
 */
async function settle<T>(read: () => Promise<T> | T, want: T, timeoutMs = WRITE_SETTLE_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (last !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

/** The source position a node id writes to, or a failed assertion saying it has none. */
function requireSourceLocation(nodeId: string): SourceNodeLocation {
  const location = decodeNodeSourceLocation(nodeId)
  expect(
    location,
    `the node id ${nodeId} carries no source location, so this case cannot read the file its gesture writes`,
  ).not.toBeNull()
  return location!
}

/**
 * Click a node inside a frame and prove the editor selected THAT node.
 *
 * The confirmation is not ceremony: `NodeRenderer` selects the innermost node
 * under the cursor, so a click that lands on a child silently retargets every
 * source assertion after it at a different element. Failing here says "the spec
 * aimed at the wrong element", which is a very different report from "the
 * gesture wrote the wrong thing".
 */
async function selectAndConfirm(page: Page, contentFrame: FrameLocator, nodeId: string): Promise<void> {
  await clickInFrame(page, contentFrame.locator(`[data-node-id="${nodeId}"]`).first())
  const rings = contentFrame.locator(SELECTION_RING)
  await expect(rings, 'clicking the element drew no selection ring').toHaveCount(1, { timeout: 15_000 })
  await expect(
    rings.first(),
    `clicking ${nodeId} selected a different node — this spec is aimed at the wrong element, not measuring a defect`,
  ).toHaveAttribute('data-canvas-overlay-node-id', nodeId, { timeout: 15_000 })
}

/** Shift+click inside a frame — `useCanvasNodeInteraction`'s RANGE select. */
async function shiftClick(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox()
  expect(box, 'the shift-click target has no bounding box').not.toBeNull()
  await page.keyboard.down('Shift')
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.keyboard.up('Shift')
}

interface DragChrome {
  /** Whether a drag ghost is painted at all — i.e. whether a session opened. */
  present: boolean
  /** `'true'` while the session is a duplicate-to plan (Alt held). */
  duplicating: string | null
  /** The refusal reason painted mid-gesture, or `null` when the drop can land. */
  refusal: string | null
}

/**
 * The drag session's own chrome, read while the pointer is still down.
 *
 * `canvasDragPainter.ts` paints into the parent document's
 * `[data-canvas-drag-layer]`: a `[data-canvas-drag-ghost]` carrying
 * `data-duplicating="true"` while Alt is held, and a
 * `[data-testid="canvas-drop-refusal"]` chip carrying `data-refusal-reason`
 * when the drop cannot land. Reading all three at once is what separates "the
 * drop was refused" from "no drag ever started".
 */
async function readDragChrome(page: Page): Promise<DragChrome> {
  return page.evaluate(() => {
    const isShown = (element: Element | null): element is HTMLElement =>
      element instanceof HTMLElement && element.style.display !== 'none'
    const ghost = document.querySelector('[data-canvas-drag-ghost]')
    const chip = document.querySelector('[data-testid="canvas-drop-refusal"]')
    return {
      present: isShown(ghost),
      duplicating: ghost?.getAttribute('data-duplicating') ?? null,
      refusal: isShown(chip) ? chip.getAttribute('data-refusal-reason') : null,
    }
  })
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** An element's box in ITS OWN frame's viewport space — what `MeasureLayer` measures. */
async function inFrameRect(target: Locator): Promise<Rect> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  })
}

/**
 * The distances K5 must draw between two boxes, derived from the boxes alone.
 *
 * Stated from the rule in `docs/agent-refs/canvas-internals.md` rather than
 * borrowed from `canvasMeasureGeometry.ts`, so this is an independent check and
 * not the implementation agreeing with itself: on each axis, two boxes that are
 * disjoint get ONE segment spanning the gap between their facing edges; two
 * boxes that overlap get TWO, one per same-side edge pair.
 */
function expectedDistances(selection: Rect, hovered: Rect): Record<string, number> {
  const out: Record<string, number> = {}
  if (hovered.right <= selection.left) out.left = selection.left - hovered.right
  else if (hovered.left >= selection.right) out.right = hovered.left - selection.right
  else {
    out.left = Math.abs(selection.left - hovered.left)
    out.right = Math.abs(hovered.right - selection.right)
  }
  if (hovered.bottom <= selection.top) out.top = selection.top - hovered.bottom
  else if (hovered.top >= selection.bottom) out.bottom = hovered.top - selection.bottom
  else {
    out.top = Math.abs(selection.top - hovered.top)
    out.bottom = Math.abs(hovered.bottom - selection.bottom)
  }
  // A zero-length segment has no pill to read, so it is not a claim this case
  // can check.
  for (const [side, value] of Object.entries(out)) if (value < 1) delete out[side]
  return out
}

/**
 * Record every value the toolbar save chip's `data-save-status` takes from now
 * on, in order. The chip is remounted between states (a `<span>` and a
 * `<Button>` are different elements), so the observer watches the document
 * rather than one node.
 */
async function startSaveStatusRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const states: string[] = []
    const push = (value: string | null) => {
      if (!value) return
      if (states[states.length - 1] !== value) states.push(value)
    }
    push(document.querySelector('[data-save-status]')?.getAttribute('data-save-status') ?? null)
    const observer = new MutationObserver(() => {
      push(document.querySelector('[data-save-status]')?.getAttribute('data-save-status') ?? null)
    })
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-save-status'],
    })
    window.__studioPhase0SaveLog = { states, observer }
  })
}

/** The states recorded so far, leaving the recorder running. */
async function peekSaveStatusRecorder(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__studioPhase0SaveLog?.states ?? [])
}

async function readSaveStatusRecorder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const log = window.__studioPhase0SaveLog
    if (!log) throw new Error('the save-status recorder was never installed')
    log.observer.disconnect()
    delete window.__studioPhase0SaveLog
    return log.states
  })
}

declare global {
  interface Window {
    __studioPhase0SaveLog?: { states: string[]; observer: MutationObserver }
  }
}
