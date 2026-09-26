import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  clickInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P3-F "Real delete undo" (ERR-2, DET-4) — in a real browser, asserted on the
 * FILE on disk and on the undo journal:
 *
 *   - Delete writes the element out of the `.tsx` (and the import it was the
 *     last use of) and records ONE journal entry;
 *   - ⌘Z puts the file back byte for byte, and the time from the keypress to
 *     the restored bytes on disk is MEASURED and held to a budget — the undo
 *     is a real write, so its latency is part of how it feels;
 *   - the restored entry is consumed; ⌘⇧Z deletes again with a fresh entry,
 *     and a second ⌘Z restores through THAT one.
 *
 * SAFETY — this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const HOME = 'pages/Home.tsx'

const HOME_PAGE = `import { Badge } from '../components/Badge'

export default function Home() {
  return (
    <main style={{ padding: "24px" }}>
      <h1 className="title">Delete undo</h1>
      <Badge label="new" />
      <p className="body">Stays put</p>
    </main>
  )
}
`

const BADGE = `export function Badge({ label }: { label: string }) {
  return <span className="badge" style={{ display: "inline-block", padding: "12px", background: "#fc0" }}>{label}</span>
}
`

/** Keypress-to-bytes budget for ⌘Z of a delete: one `/save`, one restore, no reparse on the critical path. */
const UNDO_BUDGET_MS = 1_500

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')
const journalEntries = () => {
  const folder = path.join(fixture.dir, '.studio', 'undo-journal')
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []
}

/** Poll the disk until `predicate` holds; resolves with the ms it took from `since`. */
async function msUntil(predicate: () => boolean, since: number, timeoutMs = 30_000): Promise<number> {
  while (!predicate()) {
    if (performance.now() - since > timeoutMs) throw new Error(`the file never reached the expected state within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return performance.now() - since
}

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-delete-undo-journal', {
    [HOME]: HOME_PAGE,
    'components/Badge.tsx': BADGE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

test.describe('P3-F — a delete is undone by the undo journal', () => {
  test.setTimeout(240_000)

  test('Delete, then ⌘Z restores the exact bytes within budget; ⌘⇧Z and ⌘Z go round again', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)

    const badgeId = sourceNodeId(HOME_PAGE, HOME, 'Badge', 1)
    // A call site has no element of its own: what renders is the component's
    // markup under composite ids (`<call site>~<inner>`), and a click on it
    // selects the outermost instance — the call site (P2-B).
    const badge = content.locator(`[data-node-id^="${badgeId}~"]`).first()
    await panIntoView(page, canvasRoot, badge, 80)
    await clickInFrame(page, badge)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
          return useEditorStore.getState().selectedNodeId as string | null
        }),
      )
      .toBe(badgeId)

    await page.keyboard.press('Delete')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('<Badge')
    const deleted = read(HOME)
    expect(deleted, 'the delete left the import it was the last use of').not.toContain("from '../components/Badge'")
    expect(journalEntries(), 'the delete recorded no journal entry').toHaveLength(1)
    // The inverse is filled once the delete's own commit answers.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
          const top = useEditorStore.getState()._historyPast.at(-1)
          return top?.structural?.gesture === 'source' && top.structural.source.inverse !== null
        }),
      )
      .toBe(true)

    await canvasRoot.focus()
    const undoAt = performance.now()
    await page.keyboard.press('Control+z')
    const undoMs = await msUntil(() => read(HOME) === HOME_PAGE, undoAt)
    const measured = `⌘Z after delete → restored bytes on disk: ${Math.round(undoMs)} ms`
    test.info().annotations.push({ type: 'measured', description: measured })
    console.info(`[delete-undo-journal] ${measured}`)
    expect(undoMs, `⌘Z took ${Math.round(undoMs)} ms to put the bytes back`).toBeLessThan(UNDO_BUDGET_MS)
    await expect(content.locator(`[data-node-id^="${badgeId}~"]`).first(), 'the restored element never came back on the canvas').toBeVisible({
      timeout: 30_000,
    })
    expect(journalEntries(), 'the restored entry was not consumed').toHaveLength(0)

    // ⌘⇧Z deletes again — a new write, a new entry — and ⌘Z restores through it.
    await canvasRoot.focus()
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(deleted)
    await expect.poll(journalEntries, { timeout: 10_000 }).toHaveLength(1)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
          const top = useEditorStore.getState()._historyPast.at(-1)
          return top?.structural?.gesture === 'source' && top.structural.source.inverse !== null
        }),
      )
      .toBe(true)
    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })
})
