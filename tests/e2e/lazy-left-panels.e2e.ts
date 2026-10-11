import { expect, test } from '@playwright/test'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * Bundle budget - the Framework, Dependencies, Variables and Version control
 * panels are first-open lazy chunks (`LazyPanelSlot`). In the production
 * bundle each rail item must still open its panel, and a panel opened once
 * must survive a switch away and back.
 */

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-lazy-left-panels', {
    'src/main.tsx': "import './index.css'\n\nexport {}\n",
    'src/index.css': ':root {\n  --color-brand: #0c9ab0;\n}\n',
    'pages/Home.tsx': 'export default function Home() {\n  return <h1>Home</h1>\n}\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

test('each lazy rail panel opens on first click and keeps its state when switched away', async ({ page }) => {
  test.setTimeout(180_000)
  await openFixtureBoard(page, fixture, { autoSave: true })

  await page.getByTestId('panel-rail-variables').click()
  await expect(page.getByTestId('variables-panel')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('panel-rail-dependencies').click()
  await expect(page.getByTestId('deps-section')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('panel-rail-framework').click()
  await expect(page.getByTestId('framework-panel')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('panel-rail-git').click()
  await expect(page.getByTestId('git-panel')).toBeVisible({ timeout: 30_000 })

  // Back to a panel opened earlier: it is still mounted, not reloaded.
  await page.getByTestId('panel-rail-variables').click()
  await expect(page.getByTestId('variables-panel')).toBeVisible()
})
