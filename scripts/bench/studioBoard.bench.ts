/**
 * Studio board benchmark — the canvas perf gate (`STUDIO-FIGMA-FEEL-PLAN.md` S6).
 *
 * This module does not drive a browser itself. It **shells out to Playwright's
 * own Node runner** and runs `tests/e2e/studio-board-perf.e2e.ts`, then reports
 * that spec's measurements and fails the bench when the spec fails.
 *
 * Why a subprocess rather than `lib/browser.ts`: Playwright drives Chromium
 * over `--remote-debugging-pipe`, and Bun on Windows does not wire the extra
 * stdio fds that transport needs, so `chromium.launch()` never returns. The
 * previous version of this file caught that failure and reported `skipped`,
 * which made `bench:studio-board` a perf gate that could not fail — it had
 * never once opened a browser. The Playwright test runner spawns **node**, so
 * running the spec through it is the one shape that actually executes here.
 *
 * Consequences of that choice, stated plainly:
 *
 *   - **The budgets live in the spec, not here.** `studio-board-perf.e2e.ts`
 *     owns `BUDGET_PAN_WORST_FRAME_MS`, `BUDGET_ZOOM_WORST_FRAME_MS` and the
 *     virtualization assertions, and every one of them is derived from a real
 *     run against the real corpus. Duplicating the numbers in this file would
 *     create two sources of truth that drift the first time one is ratcheted.
 *     "Fail on budget" is therefore: a breached budget fails the spec, a
 *     failed spec fails this bench, and the failing assertion's own message is
 *     reproduced in the report.
 *   - **The fixture is the spec's fixture.** The old synthetic 50-frame/20k-node
 *     project generator lived here only to feed the Bun-launched browser; it is
 *     gone with it. The spec runs against the committed twelve-frame board at
 *     `studio-workspace/__board-perf-fixture` and FAILS (no longer skips) if it
 *     is absent. The skip handling below stays as a backstop — a run that
 *     measured nothing must never be reported as a pass, whatever caused it.
 *   - **The server is the spec's server.** `playwright.config.ts`'s `webServer`
 *     starts `bun run e2e:dev` (disposable `.tmp/e2e-*` DB + uploads), so this
 *     module no longer boots one.
 */
import { resolve } from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { Type, type Static } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from './lib/types'
import { fmtMs } from './lib/stats'
import { log } from './lib/log'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SPEC_PATH = 'tests/e2e/studio-board-perf.e2e.ts'
/**
 * The Playwright CLI is invoked as `node <cli.js>` rather than through `npx`:
 * `npx` re-resolves the package (and can reach the network) on every run, and
 * its Windows shim is a `.cmd` whose argument quoting is one more thing to get
 * wrong. Spawning the local CLI with the Node binary directly is the same
 * runner with none of that — and Node, not Bun, is the entire point.
 */
const PLAYWRIGHT_CLI = resolve(REPO_ROOT, 'node_modules/@playwright/test/cli.js')

// ── Playwright's JSON report ────────────────────────────────────────────────
// Only the fields this module reads are described; the reporter emits far
// more, and TypeBox allows the rest through (no `additionalProperties: false`).

const AnnotationSchema = Type.Object({
  type: Type.String(),
  description: Type.Optional(Type.String()),
})

const TestResultSchema = Type.Object({
  status: Type.String(),
  duration: Type.Optional(Type.Number()),
  errors: Type.Optional(Type.Array(Type.Object({ message: Type.Optional(Type.String()) }))),
  annotations: Type.Optional(Type.Array(AnnotationSchema)),
})

const TestSchema = Type.Object({
  status: Type.Optional(Type.String()),
  annotations: Type.Optional(Type.Array(AnnotationSchema)),
  results: Type.Array(TestResultSchema),
})

const SpecSchema = Type.Object({
  title: Type.String(),
  /** Repo-relative, with the platform's separators. Used to tell the target spec from the `setup` project's. */
  file: Type.Optional(Type.String()),
  ok: Type.Boolean(),
  tests: Type.Array(TestSchema),
})

const SuiteSchema = Type.Recursive((Self) =>
  Type.Object({
    title: Type.Optional(Type.String()),
    specs: Type.Optional(Type.Array(SpecSchema)),
    suites: Type.Optional(Type.Array(Self)),
  }),
)

const ReportSchema = Type.Object({
  suites: Type.Array(SuiteSchema),
  errors: Type.Optional(Type.Array(Type.Object({ message: Type.Optional(Type.String()) }))),
  stats: Type.Object({
    expected: Type.Number(),
    unexpected: Type.Number(),
    skipped: Type.Number(),
    flaky: Type.Number(),
    duration: Type.Optional(Type.Number()),
  }),
})

function flattenSpecs(suites: readonly Static<typeof SuiteSchema>[]): Static<typeof SpecSchema>[] {
  const out: Static<typeof SpecSchema>[] = []
  for (const suite of suites) {
    if (suite.specs) out.push(...suite.specs)
    if (suite.suites) out.push(...flattenSpecs(suite.suites))
  }
  return out
}

/**
 * The specs from THIS spec file only.
 *
 * Load-bearing: the run also executes `playwright.config.ts`'s `setup` project
 * (`auth.setup.ts`), which is an ordinary passing test. Reading the run's
 * top-level `stats` instead would see `expected: 1` and call the run a pass
 * while the only spec that measures anything had skipped itself — the exact
 * "reported success having opened no browser" failure this module was rewritten
 * to eliminate. A skip must never be able to hide behind the setup's pass.
 *
 * Path comparison is on POSIX-normalised suffixes: Playwright reports
 * `tests\e2e\...` on Windows and `tests/e2e/...` elsewhere.
 */
function specsFromTargetFile(
  specs: readonly Static<typeof SpecSchema>[],
): Static<typeof SpecSchema>[] {
  const suffix = SPEC_PATH.split('/').pop()!
  return specs.filter((spec) => (spec.file ?? '').replace(/\\/g, '/').endsWith(suffix))
}

/**
 * The spec records every number it measures as a `perf`-typed annotation
 * (`annotate()` in `studio-board-perf.e2e.ts`), formatted `"<label>: <value>"`.
 * Those annotations ARE the bench's report rows — the alternative is
 * re-measuring the same board a second time from a second harness.
 */
function readPerfAnnotations(specs: readonly Static<typeof SpecSchema>[]): BenchRow[] {
  const rows: BenchRow[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    for (const test of spec.tests) {
      const annotations = [
        ...(test.annotations ?? []),
        ...test.results.flatMap((r) => r.annotations ?? []),
      ]
      for (const annotation of annotations) {
        if (annotation.type !== 'perf' || !annotation.description) continue
        const separator = annotation.description.indexOf(': ')
        const label =
          separator === -1 ? annotation.description : annotation.description.slice(0, separator)
        const value = separator === -1 ? '—' : annotation.description.slice(separator + 2)
        // A retry re-emits every annotation; keep the first reading of each.
        if (seen.has(label)) continue
        seen.add(label)
        rows.push({ label, metrics: { value } })
      }
    }
  }
  return rows
}

function readFailureMessages(specs: readonly Static<typeof SpecSchema>[]): string[] {
  const messages: string[] = []
  for (const spec of specs) {
    if (spec.ok) continue
    for (const test of spec.tests) {
      for (const result of test.results) {
        for (const error of result.errors ?? []) {
          if (error.message) messages.push(error.message)
        }
      }
    }
  }
  return messages
}

/** Strips Playwright's ANSI colouring so a budget failure is legible inside a markdown report. */
function plain(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/\x1b\[[0-9;]*m/g, '').trim()
}

// ── Bench module ─────────────────────────────────────────────────────────────

export const studioBoardBench: BenchModule = {
  name: 'studio-board',
  title: 'Studio board (real corpus, Playwright runner) — canvas perf gate',
  description:
    "Runs tests/e2e/studio-board-perf.e2e.ts through Playwright's Node runner and reports its measurements. The spec owns the budgets; a breached budget fails this bench. Skips (no signal, never a pass) when the Playwright CLI is absent.",

  async run(ctx: BenchContext): Promise<BenchResult> {
    if (!existsSync(PLAYWRIGHT_CLI)) {
      return skippedResult(
        this.name,
        this.title,
        `Playwright is not installed (${PLAYWRIGHT_CLI} missing) — run \`bun install\``,
      )
    }

    const reportPath = resolve(ctx.outputDir, 'studio-board-playwright-report.json')
    rmSync(reportPath, { force: true })

    log.step(`Running ${SPEC_PATH} through Playwright's Node runner`)
    const started = performance.now()
    const child = Bun.spawn(['node', PLAYWRIGHT_CLI, 'test', SPEC_PATH, '--reporter=json'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // The json reporter writes to stdout unless this is set; the webServer's
        // own piped output shares that stream, so parse a file instead.
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await child.exited
    const elapsedMs = performance.now() - started

    if (!existsSync(reportPath)) {
      throw new Error(
        `studio-board: Playwright exited ${exitCode} without writing a JSON report to ${reportPath}. ` +
          'The runner itself failed to start — check the output above.',
      )
    }

    const parsed = safeParseJson(readFileSync(reportPath, 'utf8'), ReportSchema)
    if (!parsed.ok) {
      throw new Error(
        `studio-board: Playwright's JSON report at ${reportPath} did not match the expected shape: ${parsed.error.message}`,
      )
    }
    const report = parsed.value

    const allSpecs = flattenSpecs(report.suites)
    const targetSpecs = specsFromTargetFile(allSpecs)
    const rows = readPerfAnnotations(targetSpecs)
    const { unexpected, flaky } = report.stats

    // Failures first — a failure anywhere in the run (including the `setup`
    // project, without which nothing can be measured) is a failure.
    if (exitCode !== 0 || unexpected > 0) {
      const failures = readFailureMessages(allSpecs).map(plain)
      const runnerErrors = (report.errors ?? []).map((e) => plain(e.message ?? '')).filter(Boolean)
      throw new SpecFailedError(failures, runnerErrors, exitCode)
    }

    const targetTests = targetSpecs.flatMap((spec) => spec.tests)
    if (targetTests.length === 0) {
      throw new Error(
        `studio-board: Playwright's report contains no result for ${SPEC_PATH} at all. ` +
          'The run succeeded without ever executing the spec this bench exists to measure.',
      )
    }

    // The spec ran and opted out — `studio-board-perf.e2e.ts` calls `test.skip`
    // when the corpus project it measures is not on this disk. That is "no
    // signal", and it is the one thing this bench must never report as a pass.
    if (targetTests.every((t) => t.status === 'skipped')) {
      return skippedResult(
        this.name,
        this.title,
        `${SPEC_PATH} did not run a single test — every one of them was skipped, so nothing was measured`,
      )
    }

    log.ok(
      `${SPEC_PATH} passed in ${fmtMs(elapsedMs)} (${targetTests.length} test(s), ${flaky} flaky)`,
    )

    const headlineFor = (label: string): string =>
      rows.find((r) => r.label === label)?.metrics.value ?? '—'

    return {
      name: this.name,
      title: this.title,
      headline: {
        panWorst: headlineFor('pan worst frame'),
        zoomWorst: headlineFor('zoom worst frame'),
        liveIframes: headlineFor('live iframes @ working zoom'),
      },
      sections: [
        {
          title: 'Canvas budgets (measured by tests/e2e/studio-board-perf.e2e.ts)',
          intro:
            'Every number below is read from the spec\'s own `perf` annotations. The budgets are asserted inside the spec — this bench passes exactly when the spec does.',
          rows:
            rows.length > 0
              ? rows
              : [
                  {
                    label: 'perf annotations',
                    metrics: { count: '0' },
                    notes:
                      'The spec passed but recorded no `perf` annotation — check that `annotate()` is still being called.',
                  },
                ],
        },
      ],
    }
  },
}

/**
 * Thrown when the run fails — the orchestrator records it as a FAILED bench
 * and exits non-zero (see `scripts/bench/index.ts`).
 *
 * The two causes are kept apart because they send you to different places. An
 * *assertion* failure means a budget moved and the spec's own message names
 * which one. A *runner* failure (webServer never came up, Chromium missing,
 * config error) means nothing was measured at all — reporting that as "a
 * budget was breached" would send someone hunting a perf regression that never
 * happened.
 */
class SpecFailedError extends Error {
  constructor(
    assertionFailures: readonly string[],
    runnerErrors: readonly string[],
    exitCode: number,
  ) {
    if (assertionFailures.length > 0) {
      super(`${SPEC_PATH} failed — a canvas budget was breached:\n\n${assertionFailures.join('\n\n')}`)
    } else if (runnerErrors.length > 0) {
      super(
        `${SPEC_PATH} never ran — the Playwright runner failed before any assertion:\n\n${runnerErrors.join('\n\n')}`,
      )
    } else {
      super(
        `${SPEC_PATH} failed with no recorded assertion or runner message (playwright exited ${exitCode}) — check the output above.`,
      )
    }
    this.name = 'SpecFailedError'
  }
}

function skippedResult(name: string, title: string, reason: string): BenchResult {
  log.warn(reason)
  return {
    name,
    title,
    headline: { status: `skipped — ${reason}` },
    sections: [
      {
        title: 'Skipped',
        rows: [{ label: 'studio-board', metrics: { detected: '—' }, notes: reason }],
      },
    ],
  }
}
