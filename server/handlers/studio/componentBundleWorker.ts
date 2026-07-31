/**
 * componentBundleWorker — the Tier 1 subprocess entry point for WS-3.2.
 * Spawned by `componentBundle.ts` as `process.execPath <this file>
 * <task-json>`, with `cwd` = the WORKSPACE directory (never the Studio repo
 * root) and `env` = `subprocessRunner.ts`'s `minimalSubprocessEnv()` — no
 * `STUDIO_SECRET_KEY`, no `DATABASE_URL`, no AI provider key. Same posture as
 * `styleCompileWorker.ts` (`sec-01`), for the same reason: `Bun.build`
 * resolves and reads whatever the barrel entry imports from the workspace's
 * own `node_modules`, and — unlike parsing a `.d.ts` (`packageManifest.ts`,
 * which never executes anything) — a package can ship a Bun **macro**
 * (`import { x } from './x' with { type: 'macro' }`), which genuinely runs
 * at BUILD time, in whatever process calls `Bun.build`. Confining that to a
 * subprocess with no secrets is this module's entire job; it is a
 * blast-radius boundary, not a filesystem/network sandbox — see
 * `STUDIO-IMPORT-V2-PLAN.md` §0 and `.claude/agents/security-guard.md`.
 *
 * Writes the built bundle DIRECTLY to `task.outputAbsPath` (always inside
 * `.studio/cache/`, well within `cwd`) rather than returning it over stdout —
 * a component bundle can be sizeable (unminified, per WS-3.2's own spec, for
 * readable stack traces), and writing it once here avoids a second
 * stdout-capture-then-write round trip the parent would otherwise need. Only
 * a small `{ ok, errors }` JSON crosses stdout, capped the same way
 * `styleCompileWorker.ts`'s result is.
 */
import { existsSync, rmSync, statSync } from 'node:fs'

export interface ComponentBundleTask {
  /** Absolute path to the generated barrel entry file (written by the parent before spawning). */
  entryAbsPath: string
  /** Absolute path this worker writes the built bundle to. */
  outputAbsPath: string
  /** Bare specifiers left unbundled — `react`/`react-dom`/`react/jsx-runtime`/`react/jsx-dev-runtime`, resolved in the browser by the SAME import map the plugin runtime already uses (see `componentBundle.ts`'s module doc). */
  external: string[]
  /** Bundle output over this size is refused, not silently truncated — see `componentBundle.ts`'s doc for the number. */
  maxBundleBytes: number
}

export interface ComponentBundleWorkerResult {
  ok: boolean
  errors: string[]
}

/**
 * Runs `Bun.build` against `task.entryAbsPath` and writes the result to
 * `task.outputAbsPath`. `Bun.build` resolves `node_modules` imports by
 * walking up from the entry file's own location — since the parent always
 * writes the barrel entry inside `<dir>/.studio/cache/`, that walk lands on
 * `<dir>/node_modules` exactly like running `bun build` from the workspace
 * itself would, with no explicit `cwd` option needed. Exported directly (not
 * only reachable via the `import.meta.main` subprocess block below) so tests
 * can call it against a real fixture `node_modules/` without spawning a real
 * subprocess — same seam `styleCompileWorker.ts`'s `runWorkerTask` uses.
 */
export async function runComponentBundleTask(task: ComponentBundleTask): Promise<ComponentBundleWorkerResult> {
  try {
    const result = await Bun.build({
      entrypoints: [task.entryAbsPath],
      target: 'browser',
      format: 'esm',
      minify: false,
      external: task.external,
    })

    if (!result.success) {
      return { ok: false, errors: result.logs.map((log) => log.message || String(log)) }
    }

    const jsOutput = result.outputs.find((o) => o.path.endsWith('.js')) ?? result.outputs[0]
    if (!jsOutput) return { ok: false, errors: ['Bun.build produced no output'] }

    const text = await jsOutput.text()
    await Bun.write(task.outputAbsPath, text)

    const size = statSync(task.outputAbsPath).size
    if (size > task.maxBundleBytes) {
      rmSync(task.outputAbsPath, { force: true })
      return { ok: false, errors: [`bundle is ${size} bytes, exceeding the ${task.maxBundleBytes}-byte cap`] }
    }

    return { ok: true, errors: [] }
  } catch (err) {
    if (existsSync(task.outputAbsPath)) rmSync(task.outputAbsPath, { force: true }) // never leave a partial/stale artefact behind a thrown error
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }
}

function isComponentBundleTask(value: unknown): value is ComponentBundleTask {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.entryAbsPath === 'string' &&
    typeof v.outputAbsPath === 'string' &&
    Array.isArray(v.external) &&
    typeof v.maxBundleBytes === 'number'
  )
}

// Only runs when this file is executed directly (`bun componentBundleWorker.ts <task-json>`) — never when imported by the parent process or by tests.
if (import.meta.main) {
  void (async () => {
    try {
      const raw: unknown = JSON.parse(process.argv[2] ?? '')
      if (!isComponentBundleTask(raw)) {
        process.stdout.write(JSON.stringify({ ok: false, errors: ['invalid worker task'] } satisfies ComponentBundleWorkerResult))
        process.exit(1)
        return
      }
      const result = await runComponentBundleTask(raw)
      process.stdout.write(JSON.stringify(result))
      process.exit(result.ok ? 0 : 1)
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, errors: [err instanceof Error ? err.message : String(err)] } satisfies ComponentBundleWorkerResult))
      process.exit(1)
    }
  })()
}
