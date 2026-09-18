import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  changedProjectFiles,
  createFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  snapshotProjectFiles,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { AGENT_TURN_WALL_MS } from './helpers/canvasPerf'

/**
 * **One REAL agent turn, measured end to end** (`STUDIO-FIGMA-FEEL-PLAN.md` A9).
 *
 * Everything else in `tests/e2e/` drives Studio against a fake or an offline
 * provider. This spec drives the shipping path: the `claudeCli` driver spawns
 * a real `claude` subprocess against the user's own subscription, that process
 * reaches back through `/_studio/mcp`, and its edits land in a real `.tsx` on
 * disk. `mcp-22` shipped `AGENT_TURN_ROUND_BUDGET` and the
 * `bench:agent-turn` grading against `AGENT_TURN_BUDGETS` as **warnings, not
 * failures, "until a real turn is measured"**. This is that measurement, kept
 * as a gate so the number cannot quietly drift.
 *
 * ## It costs money, so it self-skips rather than half-runs
 *
 * Three preconditions, each checked and each reported by name when it is the
 * one that is missing — a skipped run must never read as a pass:
 *
 *   1. the `claude` binary is on PATH (`claude --version`);
 *   2. Studio's own probe (`GET /admin/api/ai/providers/claude-cli/status`,
 *      the same `claude auth status --json` the driver uses) does not answer
 *      `not-installed` or `unsupported`;
 *   3. the signed-in account has a `claudeCli` credential. Studio's L1
 *      terminal login gets the HOST logged in but deliberately stores no
 *      credential row (`ProvidersTab.tsx`, WS-11 §3 P2), and
 *      `resolveCredentialForDriver` refuses an `apiKey`-mode row with no
 *      stored key — so a `claude setup-token` value in
 *      Settings → AI → Providers is what makes a real turn reachable at all.
 *      The spec never reads, logs or creates that secret; it only asks
 *      whether a row exists.
 *
 * ## What it asserts, and why each one is the honest form of the claim
 *
 * | Claim | Assertion |
 * |---|---|
 * | No fan-out | the set of project files that changed is exactly the hero's own files |
 * | One write batch | `POST /admin/api/studio/save` is intercepted at most once |
 * | No refusals | no tool row rendered `Failed …`, and no `[code=… retryable=…]` suffix anywhere in the transcript |
 * | The step budget is real | the turn used no more tool rounds than `AGENT_TURN_ROUND_BUDGET`, and the activity line was on screen while it worked |
 * | Telemetry exists | `<project>/.studio/agent-turns.jsonl` gained at least one parseable line |
 * | It finishes | wall clock under `AGENT_TURN_WALL_MS` |
 *
 * **On the "one write batch" count.** The in-canvas agent authors files with
 * the CLI's own native `Read`/`Write`/`Edit` inside the project `cwd`
 * (`claudeCliToolSurface.ts`), and `STUDIO_AGENT_TOOL_NAMES` deliberately does
 * NOT offer it `studio_apply_edits`. So a healthy turn reaches
 * `/admin/api/studio/save` **zero** times: the browser's writeback route is
 * the canvas's path, not the agent's. The assertion is therefore "at most
 * one" — more than one browser-originated save during a turn nobody clicked in
 * would be the fan-out this measures — and the observed count is printed, so a
 * future change of shape is visible rather than silently green.
 *
 * ## Reading a failure
 *
 * A failure here is a product finding, not a flaky assertion. Record it, name
 * the owning `STATE.md` entry, and mark the case `test.fail()` — never widen a
 * budget or drop an assertion to get green.
 */

const FIXTURE_NAME = '__e2e-agent-turn'
const SOURCE_PROJECT = '__canonical-fixture'

/**
 * The turn's brief. Deliberately two changes in one sentence, one structural
 * and one stylistic, against the same element — the smallest prompt that can
 * still fan out into the wrong file if the agent guesses.
 */
const PROMPT = 'Make the hero heading bolder and give the hero card a subtle shadow'

/**
 * The files the brief is ABOUT, on `__canonical-fixture`: the screen whose root
 * `<section className={heroStyles.hero}>` holds the `<h1>Book your trip</h1>`,
 * and the two stylesheets that screen imports. Anything outside this set is a
 * fan-out — the finding this spec exists for.
 */
const HERO_FILES = [
  'src/screens/CanonicalScreen.tsx',
  'src/screens/CanonicalScreen.module.css',
  'src/screens/CanonicalScreen.css',
]

/** Long enough for a real multi-round turn plus the board's cold first load. */
const TEST_TIMEOUT_MS = AGENT_TURN_WALL_MS + 180_000

/**
 * The round budget the prompt states and the driver loop caps at. Imported by
 * value rather than from `@core/ai` because the e2e tsconfig carries no
 * `@core/*` path mapping — the same reason `decodeNodeSourceLocation` restates
 * its grammar in `helpers/studioFixtureProject.ts`. Pinned against the real
 * constant by `src/__tests__/ai/turnBudget.test.ts`.
 */
const AGENT_TURN_ROUND_BUDGET = 40

/**
 * What a capture-family failure looks like IN THE PANEL when
 * `capture/browserPool.ts` cannot start a browser at all.
 *
 * `The operation timed out.` is in this list because that is what the row
 * actually renders, measured: `browserPool`'s `chromium.launch()` carries
 * playwright's own 180 s timeout, which is longer than the tool call's, so the
 * driver gives up first and the agent is told the operation timed out while
 * the real reason — `headless capture browser could not run` — only reaches
 * the SERVER log. (That gap is itself a finding: see `STATE.md` `mcp-25`.)
 * The other alternatives are the message when the browser fails fast enough
 * for the real cause to survive.
 */
const CAPTURE_UNAVAILABLE =
  /headless[- ](capture )?browser|headless-browser-unavailable|No Chromium|operation timed out/i

/**
 * The tool rows that route through `capture/browserPool.ts`. Matched on the
 * row's rendered title (`toolCallDisplay.ts` turns `studio_screenshot` into
 * "Running studio screenshot"), which is what the accessible label carries.
 */
const CAPTURE_FAMILY = /studio (screenshot|compare|computed styles|export frames)/i

/**
 * Where the run writes what it measured. Read by a human re-calibrating
 * `AGENT_TURN_WALL_MS`, and by the handoff. `.tmp/` is git-ignored and is
 * where every other disposable e2e artifact already lives.
 */
const MEASUREMENT_FILE = path.resolve('.tmp/agent-turn-measurement.json')

let fixture: FixtureProject = { dir: '', ready: false }
let skipReason: string | null = null

test.beforeAll(() => {
  fixture = createFixtureProject(SOURCE_PROJECT, FIXTURE_NAME)
  if (!fixture.ready) {
    skipReason = `studio-workspace/${SOURCE_PROJECT} is not on disk, so there is nothing to open.`
    return
  }
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (version.error || version.status !== 0) {
    skipReason =
      'the `claude` CLI is not on PATH (`claude --version` failed). Install Claude Code and re-run — this spec drives the real subprocess driver, not a fake.'
  }
})

/**
 * End the conversation, which is the product's own way to end the warm
 * `claude` process this turn started (`endClaudeCliConversation`, wired into
 * the DELETE handler by `mcp-17`).
 *
 * Without it the pool keeps that process alive for ten idle minutes with its
 * `cwd` set to the fixture directory, and Windows then refuses to unlink the
 * directory — `EPERM`, measured. Runs on every outcome, including a skip,
 * because a skipped turn can still have spawned the process before the skip
 * was decided.
 */
test.afterEach(async ({ page }) => {
  try {
    await page.evaluate(async () => {
      const res = await fetch('/admin/api/ai/conversations', { credentials: 'same-origin' })
      if (!res.ok) return
      const body = (await res.json()) as { conversations?: Array<{ id?: unknown }> }
      for (const conversation of body.conversations ?? []) {
        if (typeof conversation.id !== 'string') continue
        await fetch(`/admin/api/ai/conversations/${conversation.id}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        })
      }
    })
  } catch {
    // The page may never have navigated (an early skip). Nothing to end.
  }
})

test.afterAll(() => {
  if (fixture.ready) removeFixtureProject(fixture)
})

test('one real agent turn: one brief, one file, inside the round and wall budgets (A9)', async ({ page }) => {
  test.skip(skipReason !== null, skipReason ?? '')
  test.setTimeout(TEST_TIMEOUT_MS)

  // A same-origin page has to exist before `fetch('/admin/api/…')` can resolve
  // a relative URL, and the preconditions are read before the expensive board
  // open so a skip costs one navigation rather than a cold editor compile.
  await page.goto('/admin/dashboard')

  const status = await readJson(page, '/admin/api/ai/providers/claude-cli/status')
  const availability = String((status as { availability?: unknown }).availability ?? 'unknown')
  test.skip(
    availability === 'not-installed' || availability === 'unsupported',
    `Studio's own Claude CLI probe answered "${availability}": ${String((status as { reason?: unknown }).reason ?? 'no reason given')}`,
  )

  const credentials = (await readJson(page, '/admin/api/ai/credentials')) as {
    credentials?: Array<{ id: string; providerId: string; displayLabel: string }>
  }
  const claudeCredential = (credentials.credentials ?? []).find((c) => c.providerId === 'claudeCli')
  test.skip(
    claudeCredential === undefined,
    'this account has no Claude Code (claudeCli) credential. Add one in Settings → AI → Providers (paste the value `claude setup-token` prints) — a host login alone stores no credential row, and the driver refuses an apiKey-mode row with no key.',
  )

  // ── Arrange ────────────────────────────────────────────────────────────────

  // Balanced is persisted through the product's own route rather than by
  // clicking the control, because the control is not clickable — see the
  // `test.fail()` case at the bottom of this file. It has to happen BEFORE the
  // board opens: `AgentSessionControls` reads the mode once, in a mount
  // effect, and the panel mounts with the editor rather than when it is
  // revealed. Written first, the panel reads it back — which the assertion in
  // the panel step below then holds it to.
  const setMode = await writeJson(
    page,
    '/admin/api/ai/studio-session',
    { dir: fixture.dir, fidelityMode: 'balanced' },
    'POST',
  )
  expect(setMode.ok, `persisting the balanced fidelity mode failed with ${setMode.status}`).toBe(true)

  const before = snapshotProjectFiles(fixture)
  const turnLogPath = path.join(fixture.dir, '.studio', 'agent-turns.jsonl')
  const turnLogLinesBefore = countJsonlLines(turnLogPath)

  const writebackSaves: string[] = []
  await page.route('**/admin/api/studio/save', async (route) => {
    writebackSaves.push(route.request().postData() ?? '')
    await route.continue()
  })
  let chatTurns = 0
  await page.route('**/admin/api/ai/chat', async (route) => {
    chatTurns += 1
    await route.continue()
  })

  await test.step('point the agent at the Claude Code credential', async () => {
    const models = (await readJson(
      page,
      `/admin/api/ai/providers/claudeCli/models?credentialId=${encodeURIComponent(claudeCredential!.id)}`,
    )) as { models?: Array<{ id: string }> }
    const modelId = models.models?.[0]?.id
    expect(modelId, 'the claudeCli driver advertised no models at all').toBeTruthy()
    const put = await writeJson(page, '/admin/api/ai/defaults', {
      credentialId: claudeCredential!.id,
      modelId,
    })
    expect(put.ok, `setting the default model failed with ${put.status}`).toBe(true)
  })

  await openFixtureBoard(page, fixture, { autoSave: false })

  const panel = await test.step('open the agent panel on balanced fidelity', async () => {
    await page.getByRole('button', { name: 'Open AI assistant panel' }).click()
    const assistant = page.getByRole('complementary', { name: 'AI Assistant' })
    await expect(assistant).toBeVisible()
    const fidelity = assistant.getByRole('button', { name: /^Fidelity: / })
    await expect(fidelity, 'the agent panel rendered no fidelity control').toBeAttached({ timeout: 30_000 })
    await expect(
      fidelity,
      'the panel did not read back the balanced mode this turn persisted',
    ).toHaveAttribute('aria-label', /^Fidelity: Balanced/, { timeout: 30_000 })
    return assistant
  })

  // ── Act: one real turn, wall-clocked ───────────────────────────────────────

  const composer = panel.getByLabel('Message to AI assistant')
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await composer.fill(PROMPT)

  const startedAt = Date.now()
  await panel.getByRole('button', { name: 'Send', exact: true }).click()

  const stop = panel.getByRole('button', { name: 'Stop' })
  await expect(stop, 'the turn never started streaming — the composer accepted the message but no stream opened').toBeVisible({
    timeout: 60_000,
  })

  // The activity line is only on screen WHILE the turn works, so it has to be
  // read here rather than after. `AgentActivity` renders `role="status"` with
  // an aria-label that starts "Working." and carries the progress clause.
  const activityLabel = await panel
    .getByRole('status')
    .filter({ hasText: /./ })
    .first()
    .getAttribute('aria-label')
    .catch(() => null)
  const workingLabel = await panel
    .locator('[role="status"][aria-label^="Working."]')
    .first()
    .getAttribute('aria-label')
    .catch(() => null)

  await expect(stop, 'the turn never finished streaming').toBeHidden({ timeout: AGENT_TURN_WALL_MS })
  const elapsedMs = Date.now() - startedAt

  // ── Assert ─────────────────────────────────────────────────────────────────


  const failedToolLabels = await panel
    .locator('[role="status"][aria-label^="Failed "]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label') ?? ''))
  // The whole panel, whitespace-collapsed. A failed row's MESSAGE is rendered
  // in a sibling of the `role="status"` element (`ToolCallRow`'s `errorMessage`
  // block), so the row's own text is only the title — reading the transcript is
  // the only way to see WHY a tool refused.
  const transcript = (await panel.innerText()).replace(/\s+/g, ' ')
  const rounds = await panel.locator('[role="status"][aria-label^="Completed "]').count()
  const telemetryLines = countJsonlLines(turnLogPath)
  const changes = changedProjectFiles(fixture, before)

  // Written before the first assertion so a FAILING run still reports what the
  // turn actually did. Re-calibrating `AGENT_TURN_WALL_MS` means running this
  // spec three times and reading three of these, which a failure in a later
  // step must not take away.
  writeMeasurement({
    elapsedMs,
    wallBudgetMs: AGENT_TURN_WALL_MS,
    rounds,
    roundBudget: AGENT_TURN_ROUND_BUDGET,
    chatTurns,
    writebackSaves: writebackSaves.length,
    telemetryLinesAdded: telemetryLines - turnLogLinesBefore,
    failedToolLabels,
    changes,
    activityLabel: workingLabel ?? activityLabel,
  })

  // An ENVIRONMENT precondition discovered late rather than early, and the one
  // place this spec stops short of asserting. `studio_screenshot` /
  // `studio_compare` / `studio_computed_styles` all route through
  // `capture/browserPool.ts`'s `chromium.launch()`, and on a machine where
  // that binary cannot start (measured here: `playwright-core`'s
  // `chrome-headless-shell` hangs for the full 180 s launch timeout under
  // Bun, while the same binary serves the Playwright RUNNER fine) every one of
  // them refuses `headless-browser-unavailable` and the agent works blind.
  //
  // That is not the turn the product ships, so claiming a pass on it would be
  // a lie — and failing on it would report a machine as a product defect. It
  // skips, with the reason. Any OTHER failed tool call still fails below.
  const captureBlocked =
    failedToolLabels.length > 0 &&
    failedToolLabels.every((label) => CAPTURE_FAMILY.test(label)) &&
    CAPTURE_UNAVAILABLE.test(transcript)
  test.skip(
    captureBlocked,
    `this machine's headless capture browser could not launch, so ${failedToolLabels.length} verification tool call(s) refused and the agent ran blind. Measured turn: ${elapsedMs} ms, ${rounds} rounds, ${writebackSaves.length} writeback POST(s).`,
  )

  await test.step(`the turn finished in ${elapsedMs} ms`, async () => {
    expect(
      elapsedMs,
      `the turn took ${elapsedMs} ms against the ${AGENT_TURN_WALL_MS} ms budget in helpers/canvasPerf.ts`,
    ).toBeLessThan(AGENT_TURN_WALL_MS)
    expect(chatTurns, 'more than one chat request went out for one Send').toBe(1)
  })

  await test.step('no tool call refused', async () => {
    expect(
      failedToolLabels,
      `tool calls failed during the turn: ${failedToolLabels.join(' | ')}`,
    ).toEqual([])
    // A14 renders a structured refusal INTO the error string as
    // `… [code=<code> retryable=<bool>]`. It must not appear anywhere.
    expect(transcript, 'a structured tool refusal reached the transcript').not.toContain('[code=')
  })

  await test.step('the turn stayed inside the round budget and showed its work', async () => {
    expect(
      rounds,
      `the turn used ${rounds} tool rounds against AGENT_TURN_ROUND_BUDGET=${AGENT_TURN_ROUND_BUDGET}`,
    ).toBeLessThanOrEqual(AGENT_TURN_ROUND_BUDGET)
    expect(
      workingLabel ?? activityLabel,
      'no activity line was on screen while the turn ran — "is it stuck?" is unanswerable',
    ).toBeTruthy()
    expect(workingLabel ?? '').toMatch(/^Working\./)
  })

  await test.step('per-round telemetry landed in the project', async () => {
    expect(
      telemetryLines,
      `.studio/agent-turns.jsonl gained ${telemetryLines - turnLogLinesBefore} line(s); bench:agent-turn has nothing to grade without them`,
    ).toBeGreaterThan(turnLogLinesBefore)
  })

  await test.step(`the write reached only the hero's own files (${writebackSaves.length} writeback POST(s))`, async () => {
    expect(
      writebackSaves.length,
      `${writebackSaves.length} browser writeback batches for a turn nobody clicked in`,
    ).toBeLessThanOrEqual(1)

    expect(changes.removed, `the turn deleted files: ${changes.removed.join(', ')}`).toEqual([])
    expect(changes.added, `the turn created files: ${changes.added.join(', ')}`).toEqual([])
    expect(
      changes.modified.length,
      'the turn reported success but changed no file at all',
    ).toBeGreaterThan(0)
    const strays = changes.modified.filter((rel) => !HERO_FILES.includes(rel))
    expect(
      strays,
      `the turn edited files outside the hero: ${strays.join(', ')} (changed: ${changes.modified.join(', ')})`,
    ).toEqual([])
  })
})

/**
 * **Known product defect — `STATE.md` `mcp-25`, owner `panel-designer`.**
 *
 * The agent panel's bottom control row does not fit its own default width. At
 * 328 px the four session controls (Bypass, Fidelity, Design system, the
 * model/effort picker) render **on top of each other**: measured from a real
 * run, `ModelEffortPicker`'s "Claude · Claude Opus" label sits over the
 * Fidelity trigger and takes every click aimed at it. Playwright reports it
 * as `<span class="_triggerLabel_…">Claude · Claude Opus</span> … intercepts
 * pointer events`, retried for the whole test timeout.
 *
 * It is not only a test problem. A user cannot change fidelity or design
 * policy at the panel's default width either — the two controls `mcp-22` and
 * `A12` shipped are unreachable by mouse, and the row is illegible.
 *
 * Marked `test.fail()` so the fix flips it green and cannot land silently.
 * The turn case above sets the mode through the same route the control posts
 * to, so the defect blocks the control, not the measurement.
 */
test('the agent panel fidelity control is clickable at the panel default width', async ({ page }) => {
  test.fail()
  test.skip(skipReason !== null, skipReason ?? '')
  test.setTimeout(180_000)

  await openFixtureBoard(page, fixture, { autoSave: false })
  await page.getByRole('button', { name: 'Open AI assistant panel' }).click()
  const panel = page.getByRole('complementary', { name: 'AI Assistant' })
  await expect(panel).toBeVisible()

  const trigger = panel.getByRole('button', { name: /^Fidelity: / })
  await expect(trigger).toBeVisible({ timeout: 30_000 })
  await trigger.click({ timeout: 10_000 })
  await expect(page.getByRole('menu', { name: 'Fidelity' })).toBeVisible({ timeout: 10_000 })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

/** A same-origin authenticated GET from inside the page, parsed. Throws with the status when the route refuses. */
async function readJson(page: Page, url: string): Promise<unknown> {
  return page.evaluate(async (target: string) => {
    const res = await fetch(target, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`GET ${target} answered ${res.status}`)
    return res.json()
  }, url)
}

/** A same-origin authenticated write from inside the page. Returns the status rather than throwing, so the caller can assert on it. */
async function writeJson(
  page: Page,
  url: string,
  body: unknown,
  method: 'PUT' | 'POST' = 'PUT',
): Promise<{ ok: boolean; status: number }> {
  return page.evaluate(
    async ({ target, payload, verb }: { target: string; payload: unknown; verb: string }) => {
      const res = await fetch(target, {
        method: verb,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { ok: res.ok, status: res.status }
    },
    { target: url, payload: body, verb: method },
  )
}

/**
 * Append one run's numbers to `.tmp/agent-turn-measurement.json`.
 *
 * Appends rather than overwrites: the budget is 1.5x the WORST of three runs,
 * and three separate `playwright test` invocations would otherwise each erase
 * the last. Never throws — a measurement artifact is evidence, not a gate.
 */
function writeMeasurement(entry: Record<string, unknown>): void {
  try {
    const previous = fs.existsSync(MEASUREMENT_FILE)
      ? (JSON.parse(fs.readFileSync(MEASUREMENT_FILE, 'utf8')) as unknown)
      : []
    const runs = Array.isArray(previous) ? previous : []
    runs.push({ at: new Date().toISOString(), ...entry })
    fs.mkdirSync(path.dirname(MEASUREMENT_FILE), { recursive: true })
    fs.writeFileSync(MEASUREMENT_FILE, `${JSON.stringify(runs, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.warn('[agent-turn] could not record the measurement:', err)
  }
}

/** Lines in a JSONL file that parse as objects. `0` when the file does not exist yet. */
function countJsonlLines(file: string): number {
  if (!fs.existsSync(file)) return 0
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false
      try {
        return typeof JSON.parse(line) === 'object'
      } catch {
        return false
      }
    }).length
}
