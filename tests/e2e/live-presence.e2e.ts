import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN_ORIGIN } from '../../scripts/lib/e2eStack'
import { OWNER_STATE_FILE } from './helpers/constants'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * MP-1 / MP-2 - live presence, in two real browser contexts on one project.
 *
 * What only a real browser can show: the WebSocket upgrades through the dev
 * proxy with the session cookie, the roster reaches the second tab, a cursor
 * moved with the real mouse in tab A lands in tab B's overlay at the same
 * BOARD point (both tabs reset to the same view), and the cursor leaves with
 * the tab. Both contexts are the one owner account, so the toolbar avatar stack
 * (one avatar per PERSON) is empty by design; the cursor overlay is per tab and
 * is what is asserted. Follow and the avatar click are covered by the reducer
 * and follow-maths unit tests; a second account is not worth minting here.
 *
 * The fixture is authored under this run's throwaway workspace copy. Nothing in
 * it is edited.
 */

const PAGE_SOURCE = `export default function Home() {
  return (
    <main>
      <h1>Presence</h1>
    </main>
  )
}
`

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-live-presence', { 'pages/Home.tsx': PAGE_SOURCE })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function emptyBoardPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('canvas-root').boundingBox()
  if (!box) throw new Error('the canvas root has no bounding box')
  // The top-left corner area of the canvas root is board background after Ctrl+0.
  return { x: box.x + 40, y: box.y + 40 }
}

test('a cursor moved in one tab appears in the other at the same board point, and leaves with the tab', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000)
  await openFixtureBoard(page, fixture, { autoSave: false })

  const second = await browser.newContext({ storageState: OWNER_STATE_FILE, baseURL: E2E_ADMIN_ORIGIN })
  const other = await second.newPage()
  try {
    await openFixtureBoard(other, fixture, { autoSave: false })

    // Both tabs joined the room: each sees the other's presence layer.
    await expect(page.getByTestId('board-peers-layer')).toBeAttached({ timeout: 30_000 })
    await expect(other.getByTestId('board-peers-layer')).toBeAttached({ timeout: 30_000 })

    const target = await emptyBoardPoint(page)
    const startedAt = Date.now()
    await page.mouse.move(target.x - 10, target.y - 10)
    await page.mouse.move(target.x, target.y, { steps: 6 })

    const cursor = other.getByTestId('peer-cursor')
    await expect(cursor).toBeVisible({ timeout: 5_000 })
    const latencyMs = Date.now() - startedAt
    test.info().annotations.push({ type: 'cursor-latency-ms', description: String(latencyMs) })

    // Same view in both tabs, so the same board point is the same screen point.
    await expect
      .poll(async () => {
        const box = await cursor.boundingBox()
        const peerBox = await other.getByTestId('canvas-root').boundingBox()
        const ownBox = await page.getByTestId('canvas-root').boundingBox()
        if (!box || !peerBox || !ownBox) return Number.POSITIVE_INFINITY
        const dx = box.x - peerBox.x - (target.x - ownBox.x)
        const dy = box.y - peerBox.y - (target.y - ownBox.y)
        return Math.hypot(dx, dy)
      }, { timeout: 5_000 })
      .toBeLessThan(40)

    // Closing the tab removes its cursor from the other (member-left).
    await page.close()
    await expect(cursor).toBeHidden({ timeout: 10_000 })
  } finally {
    await second.close()
  }
})
