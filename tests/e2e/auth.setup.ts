import { expect, test as setup } from '@playwright/test'
import { OWNER_STATE_FILE } from './helpers/constants'
import { completeSetupOrLogin } from './helpers/auth'
import { openSiteEditor } from './helpers/editor'

/**
 * Setup project — runs once before every `*.e2e.ts` spec (declared as a
 * dependency in `playwright.config.ts`).
 *
 * The Playwright `webServer` resets the disposable database once per run, so
 * first-run setup can only happen once. This project performs it, proving the
 * SETUP-001 journey end to end (clean DB → owner created → editor reachable),
 * then saves the owner's authenticated `storageState`. Specs that opt in via
 * `storageState` start already logged in; the session created here is never
 * signed out, so it stays valid for the whole run.
 */
setup('create owner and reach the editor (SETUP-001)', async ({ page }) => {
  // This project pays the one-time cold cost for the entire run: the dev
  // server compiles the editor chunk on demand on the FIRST navigation to
  // `/admin/site`, and `expectEditorReady` waits up to 60s for it. The config's
  // 60s per-test default would expire during that wait and fail the setup —
  // which fails every spec in the run, because they all depend on it.
  setup.setTimeout(240_000)

  await completeSetupOrLogin(page)

  // A freshly set-up site lands the owner in a usable editor, not a dead end.
  await openSiteEditor(page)
  await expect(page.getByTestId('account-menu-trigger')).toBeVisible()

  await page.context().storageState({ path: OWNER_STATE_FILE })
})
