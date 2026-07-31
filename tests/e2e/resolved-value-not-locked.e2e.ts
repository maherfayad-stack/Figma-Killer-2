import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for `lock-01`: a node whose VALUE the evaluator had to
 * resolve is no longer locked.
 *
 * The user's report was "a lot of sections, components and stuff is locked, I
 * can't edit". The census behind it: 276 of the 802 nodes across the 15 eSIM
 * screens were locked, and **149 of those (54%) for nothing but a resolved
 * value** — `withResolutionLock` set `locked: true` because one attribute came
 * from `{t.homepage.upcomingTrip}` rather than a literal. Each of them then
 * rendered a notice opening with *"This element can't be moved or deleted from
 * here"*, which is false for an ordinary element written at a known line and
 * column. The parser now locks on STRUCTURE alone (`withResolution` in
 * `src/core/page-parser/nodeResolution.ts`).
 *
 * Both halves have to hold, and a unit test can only see one of them:
 *
 *  1. the element is genuinely draggable/reorderable in the layers tree, and
 *     the notice a user reads no longer claims otherwise;
 *  2. the value that genuinely has no writable target STILL refuses, with a
 *     reason, in the same panel.
 *
 * `SectionTitle` at `HomepageScreen.jsx:163:14` is the canonical shape: a
 * `studio.instance` whose `title`/`actionLabel` both resolve out of the i18n
 * dictionary (so `codeProps` names them) sitting at an ordinary source
 * location. On unmodified HEAD it was locked with `lockReason: 'value from
 * t.homepage.upcomingTrip'`.
 */

const HOMEPAGE_ID = 'homepage-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
const SECTION_TITLE_NODE_ID = 'journey-screens/src/screens/HomepageScreen.jsx:163:14'

interface StudioProjectSummary {
  dir: string
  name: string
}

/** Same lookup `parser-branch-selection.e2e.ts` uses — matched by trailing folder name, so `/` vs `\` is irrelevant. */
async function findEsimStackProjectDir(page: Page): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === 'maherfayad-stack-eSIM')
  return match?.dir ?? null
}

/** Native wheel = pan. Identical mechanism to `parser-branch-selection.e2e.ts`'s helper. */
async function panIntoView(page: Page, canvasRoot: Locator, target: Locator, tolerancePx = 40): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) throw new Error(`panIntoView: target frame [data-page-id="${HOMEPAGE_ID}"] has no bounding box`)

    const dx = targetBox.x + targetBox.width / 2 - (rootBox.x + rootBox.width / 2)
    const dy = targetBox.y + targetBox.height / 2 - (rootBox.y + rootBox.height / 2)
    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target frame never reached the viewport center after 8 pan attempts')
}

test.describe('lock-01: a resolved VALUE does not lock its element', () => {
  test('the section title selects, says something true, drags — and its resolved props still refuse', async ({ page }) => {
    const projectDir = await findEsimStackProjectDir(page)
    if (!projectDir) {
      test.skip(true, 'studio-workspace/maherfayad-stack-eSIM is not present on disk for this run')
      return
    }

    await page.addInitScript((dir: string) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
    }, projectDir)

    await page.goto('/admin/site?studio')
    await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('board-frames-layer')).toBeAttached()

    const targetFrame = page.locator(`[data-page-id="${HOMEPAGE_ID}"]`)
    await expect(targetFrame).toHaveCount(1)
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })
    await panIntoView(page, page.getByTestId('canvas-root'), targetFrame)

    const iframeEl = targetFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(iframeEl).toBeVisible({ timeout: 15_000 })
    const contentFrame = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    // ── Real click on the real copy ───────────────────────────────────────
    // "Upcoming trip" is the SectionTitle's resolved `title`. Clicking it
    // selects the enclosing `studio.instance` — the node that was locked.
    const sectionTitle = contentFrame.getByText('Upcoming trip', { exact: true }).first()
    await expect(sectionTitle).toBeVisible({ timeout: 15_000 })
    await sectionTitle.click()

    // ── 1. The notice tells the truth ─────────────────────────────────────
    const notice = page.getByTestId('source-constraint-notice')
    await expect(notice).toBeVisible({ timeout: 10_000 })
    await expect(
      notice,
      'a resolution-only node must not be told it cannot be moved — that is the false clause lock-01 removed',
    ).toHaveAttribute('data-variant', 'values-only')
    await expect(notice).not.toContainText("can't be moved or deleted")
    await expect(notice).toContainText('it is not locked')
    await expect(notice).toContainText('value from t.homepage.upcomingTrip')

    // ── 2. The refusal that must SURVIVE ──────────────────────────────────
    // `title` resolved out of the i18n dictionary: writing a literal back over
    // `{t.homepage.upcomingTrip}` would delete the binding, so the panel must
    // still offer a read-only summary with a reason, not an input.
    const titleRow = page.getByTestId('instance-call-site-prop-title')
    await expect(titleRow).toBeVisible()
    await expect(titleRow).toContainText('Upcoming trip')
    await expect(titleRow, 'the resolved prop must still refuse, with a readable reason').toContainText(
      'set in code',
    )
    await expect(
      titleRow.locator('input, textarea'),
      'a code-valued prop must not render an editable input — that is "I typed and nothing happened"',
    ).toHaveCount(0)

    // ── 3. The element is genuinely reorderable ───────────────────────────
    // Selecting the node auto-expands its ancestors and scrolls the layers
    // tree to its row, so the row is addressable without hand-expanding.
    const explorer = page.getByRole('complementary', { name: 'Explorer' })
    if (!(await explorer.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Open Explorer panel' }).click()
    }
    const tree = page.getByRole('tree', { name: 'Page element tree' })
    if (!(await tree.isVisible().catch(() => false))) {
      await explorer.getByRole('button', { name: 'Layers', exact: true }).click()
    }
    await expect(tree).toBeVisible()

    const row = page.getByTestId(`dom-tree-item-${SECTION_TITLE_NODE_ID}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    // `TreeNode` appends "locked" to the row's accessible name, and only wires
    // dnd-kit's draggable attributes when the node is NOT locked — both are
    // read straight off `node.locked`, so this is the lock itself, observed.
    await expect(row).not.toHaveAttribute('aria-label', /locked/)
    await expect(row, 'an unlocked layer row carries dnd-kit\'s draggable attributes').toHaveAttribute(
      'aria-roledescription',
      'draggable',
    )

    // Drag it past its next sibling and assert the tree order actually changed.
    const rows = tree.getByRole('treeitem')
    const idsBefore = await rows.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.studioNodeId ?? ''),
    )
    const startIndex = idsBefore.indexOf(SECTION_TITLE_NODE_ID)
    expect(startIndex, 'the section title row was not found in the layers tree').toBeGreaterThan(-1)

    // LANDMINE: the layers tree scrolls, and BOTH dnd-kit and `useDomPanelDnd`
    // auto-scroll it when the pointer comes within 32px of an edge. A drag
    // started on a row near the bottom edge scrolls the list out from under the
    // rects measured at drag start, and no drop target ever resolves — it looks
    // exactly like a refused drop but is a measurement race. Centre the row
    // first, then drag in small steps.
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(500)

    const dropTarget = rows.nth(startIndex + 1)
    const [from, to] = await Promise.all([row.boundingBox(), dropTarget.boundingBox()])
    if (!from || !to) throw new Error('the drag source or drop target has no bounding box')

    await page.mouse.move(from.x + 120, from.y + from.height / 2)
    await page.mouse.down()
    // Past the PointerSensor's 5px activation distance first…
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(from.x + 120, from.y + from.height / 2 + step * 3)
      await page.waitForTimeout(30)
    }
    // …then into the next row's bottom edge band, where the drop resolves to
    // "after" it — an ordinary sibling reorder under the same parent.
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(to.x + 120, to.y + to.height * 0.5 + step)
      await page.waitForTimeout(60)
    }
    await expect(dropTarget).toHaveAttribute('data-drop-position', 'after')
    await page.mouse.up()

    await expect(async () => {
      const idsAfter = await rows.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.studioNodeId ?? ''),
      )
      expect(
        idsAfter.indexOf(SECTION_TITLE_NODE_ID),
        'the row never moved — on unmodified HEAD this node was locked and dnd-kit refused to drag it',
      ).toBeGreaterThan(startIndex)
    }).toPass({ timeout: 5_000 })
  })
})
