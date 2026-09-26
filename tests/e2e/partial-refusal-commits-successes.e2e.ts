import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  readToastRecorder,
  removeFixtureProject,
  sourceNodeId,
  startToastRecorder,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * P3-A (WB-12, WB-13, WB-35) — a save batch the server PARTLY refuses commits
 * what it wrote, warns once, and re-sends only what it refused.
 *
 * Before P3-A an unwritable value edit came back as an anonymous "skip": the
 * client showed one red "Some changes were not saved to source" (blaming "text
 * that comes from a prop or a variable" whatever the cause), and — because the
 * response only carried aggregate counts — held back EVERY baseline in the
 * batch, so every later save re-sent edits that had already landed.
 *
 * How the refusal is produced: the real server writes the successes; this spec
 * takes the "Lede" edit out of the request on its way and answers for it with
 * the `mixed-children` refusal the server gives a text edit on an element that
 * holds more than text. (Getting a REAL mixed-children refusal through the
 * board would need the file to change under an open board, which the project
 * watcher — P1-D — immediately re-reads; the refusal's path from the response
 * onwards is exactly the production one.)
 *
 * SAFETY — this spec WRITES, so its fixture lives under this run's throwaway
 * copy of `studio-workspace/` and is removed afterwards.
 */

const REL = 'pages/Home.tsx'

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main className="page">
      <h1 className="title">Title</h1>
      <p className="lede">Lede</p>
      <p className="note">Note</p>
    </main>
  )
}
`

const TYPED = '-edited'
const TITLE = sourceNodeId(FIXTURE_PAGE, REL, 'h1', 1)
const LEDE = sourceNodeId(FIXTURE_PAGE, REL, 'p', 1)
const NOTE = sourceNodeId(FIXTURE_PAGE, REL, 'p', 2)

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, ...REL.split('/')), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-partial-refusal', {
    [REL]: FIXTURE_PAGE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface SaveEdit {
  kind: string
  nodeId: string
}

/**
 * Pass every `/save` through to the real server with the Lede edit taken out,
 * and answer for it with a named refusal. Records what each save SENT.
 */
async function refuseLedeOnTheWay(page: Page): Promise<SaveEdit[][]> {
  const sent: SaveEdit[][] = []
  await page.route('**/admin/api/studio/save', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { edits?: SaveEdit[] }
    const edits = body.edits ?? []
    sent.push(edits)
    const lede = edits.filter((edit) => edit.nodeId === LEDE)
    const response = await route.fetch({
      postData: JSON.stringify({ ...body, edits: edits.filter((edit) => edit.nodeId !== LEDE) }),
    })
    const result = (await response.json()) as { skipped: number; refusals?: unknown[] }
    await route.fulfill({
      response,
      json: {
        ...result,
        skipped: result.skipped + lede.length,
        refusals: [
          ...(result.refusals ?? []),
          ...lede.map((edit) => ({
            nodeId: edit.nodeId,
            kind: edit.kind,
            reason: 'mixed-children',
            message:
              'This element holds other elements or code next to its text, so rewriting the text would overwrite them. Nothing was written; change this text in the code.',
          })),
        ],
      },
    })
  })
  return sent
}

async function appendTextInline(page: Page, canvasRoot: Locator, content: FrameLocator, nodeId: string, was: string) {
  const target = content.locator(`[data-node-id="${nodeId}"]`).first()
  await panIntoView(page, canvasRoot, target, 80)
  const box = await target.boundingBox()
  expect(box, `${was} has no bounding box`).not.toBeNull()
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(content.locator('[contenteditable]')).toHaveCount(1, { timeout: 15_000 })
  await page.keyboard.insertText(TYPED)
  await page.keyboard.press('Control+Enter')
  await expect(target).toHaveText(`${was}${TYPED}`)
}

test.describe('P3-A — a partly refused save', () => {
  test.setTimeout(180_000)

  test('commits its successes, warns once with a remedy, and re-sends only the refused edit', async ({ page }) => {
    const sent = await refuseLedeOnTheWay(page)
    // Autosave off: both edits go out in ONE batch, on ⌘S.
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)
    await expect(content.locator(`[data-node-id="${TITLE}"]`)).toBeVisible({ timeout: 30_000 })

    await appendTextInline(page, canvasRoot, content, TITLE, 'Title')
    await appendTextInline(page, canvasRoot, content, LEDE, 'Lede')
    // Every card inserted from here on is counted, dismissed or not.
    await startToastRecorder(page)
    await page.keyboard.press('Control+s')

    await expect.poll(() => sent.length, { message: 'the batch never went out', timeout: 30_000 }).toBe(1)
    expect(sent[0]!.map((edit) => edit.nodeId).sort()).toEqual([LEDE, TITLE].sort())
    // The success landed; the refused edit did not.
    await expect.poll(readPage, { timeout: 30_000 }).toContain(`Title${TYPED}`)
    expect(readPage()).toContain('<p className="lede">Lede</p>')

    // One warning, naming the real cause, with its remedy.
    const warning = page.locator('[data-toast-kind="warning"]', { hasText: 'Text not saved to source' })
    await expect(warning.getByRole('button', { name: 'Open in code' })).toBeVisible()

    // A later save: the landed Title edit is NOT sent again; the refused Lede
    // edit still is (it is the user's pending change), and the warning is not
    // repeated as a second card.
    await appendTextInline(page, canvasRoot, content, NOTE, 'Note')
    await page.keyboard.press('Control+s')
    await expect.poll(() => sent.length, { message: 'the second save never went out', timeout: 30_000 }).toBe(2)
    expect(sent[1]!.map((edit) => edit.nodeId).sort()).toEqual([LEDE, NOTE].sort())
    await expect.poll(readPage, { timeout: 30_000 }).toContain(`Note${TYPED}`)

    const cards = await readToastRecorder(page)
    expect(cards.filter((card) => card.kind === 'error'), 'a red card appeared').toEqual([])
    expect(
      cards.filter((card) => card.kind === 'warning' && card.title.includes('Text not saved to source')),
      'the refusal should warn exactly once across both saves',
    ).toHaveLength(1)
  })
})
