/**
 * styleCompileTier1 — `compileSass`/`compilePostcssPipeline`, split out of
 * `styleCompile.ts` (which owns the Tier 0 CSS Modules transform, the WS-2.3
 * vendor-CSS scan, the on-disk cache, and `compileProjectStyles`'s overall
 * orchestration) purely to keep `styleCompile.ts` under the repo's
 * module-size-budget gate. This is one cohesive slice: everything a
 * Sass/PostCSS/Tailwind compile needs, from resolving the workspace's own
 * installed packages to running them.
 *
 * `sec-01`: Tier 1 compilation runs in a SUBPROCESS
 * (`styleCompileWorker.ts`, spawned via `subprocessRunner.ts`'s
 * `runCappedSubprocess`), never in this process. Running a workspace's
 * `postcss.config.js` or a Sass plugin chain in-process would hand that
 * arbitrary JS the admin server's own ambient authority — the whole
 * filesystem, the network, and every secret in `process.env`
 * (`STUDIO_SECRET_KEY`, `DATABASE_URL`, AI provider keys). The subprocess:
 *
 *   - runs with `cwd` = the workspace directory (never the Studio repo root)
 *   - runs with an explicit, minimal `env` (`minimalSubprocessEnv()` — no
 *     secrets forwarded)
 *   - is killed on a timeout (`COMPILE_TIMEOUT_MS`), with stdout/stderr
 *     capped so a runaway or chatty compiler can't exhaust memory
 *   - is resolved by an EXPLICIT path (`resolveWorkspacePackageEntry`, in
 *     `workspacePackageResolve.ts`) — never the host admin server's own
 *     `node_modules` — and that resolution is symlink-containment-checked:
 *     a `node_modules/<pkg>` entry that is actually a symlink escaping the
 *     workspace directory does not resolve
 *
 * This is still a **blast-radius** boundary, not a filesystem/network
 * sandbox — see `STUDIO-IMPORT-V2-PLAN.md` §0 and
 * `.claude/agents/security-guard.md`. Tier 1 is explicit, informed, revocable
 * consent to run the workspace's own code; what the subprocess buys is that a
 * hang or crash can't take the admin server down, and the workspace's code
 * never held a copy of the server's secrets to begin with.
 */
import { join } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import type { ProbeWarning, ProjectProfile } from './projectProfileSchema'
import { CSS_MODULE_FILE_RE, readCappedFile } from './styleCompileFileRead'
import { runCappedSubprocess, minimalSubprocessEnv, type SubprocessSpawnFn } from './subprocessRunner'
import { isRealpathContained, resolveWorkspacePackageEntry } from './workspacePackageResolve'

const COMPILE_TIMEOUT_MS = 20_000

/** Absolute path to the subprocess entry point. `import.meta.dir` is this file's own directory on disk — reliable under Bun, which runs server TypeScript directly (no bundling step for `server/`). */
const WORKER_SCRIPT_PATH = join(import.meta.dir, 'styleCompileWorker.ts')

/** Compiled CSS can be sizeable (a real Tailwind JIT pass over a large project) — generous but bounded. */
const STYLE_WORKER_MAX_STDOUT_BYTES = 4 * 1024 * 1024
/** stderr is diagnostics only, folded into a warning message — a small cap is plenty. */
const STYLE_WORKER_MAX_STDERR_BYTES = 64 * 1024

interface StyleWorkerResult {
  css?: string
  errors: Array<{ relPath?: string; message: string }>
}

/** Test seam for `sec-01`'s adversarial subprocess tests (timeout, output-cap, argv/env assertions) — never touched by the real `studioPageLoad.ts` call path, which always uses the real `Bun.spawn`/`setTimeout`. */
export interface StyleCompileOverrides {
  spawn?: SubprocessSpawnFn
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

/**
 * Spawns `styleCompileWorker.ts` with `task` as its sole argv, waits for it
 * (killing it on `COMPILE_TIMEOUT_MS`), and turns every failure mode —
 * timeout, non-zero exit, unparseable stdout, a per-file error the worker
 * reported — into a warning on `warnings`, never a thrown error. `cwd` is
 * `dir` (the workspace, never the Studio repo root); `env` is
 * `minimalSubprocessEnv()` (no secrets forwarded).
 */
async function runStyleCompileWorker(
  dir: string,
  task: import('./styleCompileWorker').WorkerTask,
  warnings: ProbeWarning[],
  failureCode: string,
  overrides: StyleCompileOverrides,
): Promise<StyleWorkerResult | undefined> {
  const result = await runCappedSubprocess([process.execPath, WORKER_SCRIPT_PATH, JSON.stringify(task)], {
    cwd: dir,
    env: minimalSubprocessEnv(),
    timeoutMs: COMPILE_TIMEOUT_MS,
    maxStdoutBytes: STYLE_WORKER_MAX_STDOUT_BYTES,
    maxStderrBytes: STYLE_WORKER_MAX_STDERR_BYTES,
    spawn: overrides.spawn,
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
  })

  if (result.timedOut) {
    warnings.push({
      code: failureCode,
      message: `Style compilation timed out after ${COMPILE_TIMEOUT_MS}ms.`,
      fix: "The project's style toolchain may be stuck (e.g. a config in watch mode); check it for infinite loops.",
    })
    return undefined
  }
  if (result.exitCode !== 0) {
    console.error('[studio:styleCompile] worker exited non-zero', result.exitCode, result.stderr)
    warnings.push({
      code: failureCode,
      message: `Style compilation process exited with code ${result.exitCode}${result.stderr ? `: ${result.stderr.slice(0, 500)}` : ''}`,
      fix: "Check the project's style toolchain config for errors.",
    })
    return undefined
  }

  try {
    const parsed = JSON.parse(result.stdout) as StyleWorkerResult
    for (const err of parsed.errors) {
      warnings.push({
        code: failureCode,
        message: err.relPath ? `Failed to compile ${err.relPath}: ${err.message}` : err.message,
        fix: 'Check the file for syntax errors.',
      })
    }
    return parsed
  } catch (err) {
    console.error('[studio:styleCompile] could not parse worker output', err)
    warnings.push({
      code: failureCode,
      message: 'Style compilation produced output that could not be read.',
      fix: "Check the project's style toolchain config for errors.",
    })
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Sass/Less — Tier 1
// ---------------------------------------------------------------------------

/** Every non-module `.scss`/`.sass` file, compiled through the workspace's own `sass` package (its real public API — `compileString`), concatenated. `.module.scss` is excluded — see `styleCompile.ts`'s `compileCssModules` doc. Runs in the `styleCompileWorker.ts` subprocess. */
export async function compileSass(dir: string, warnings: ProbeWarning[], overrides: StyleCompileOverrides): Promise<string> {
  const files = listWorkspaceFiles(dir)
    .filter((f) => /\.(scss|sass)$/i.test(f) && !CSS_MODULE_FILE_RE.test(f))
    .sort()
  if (files.length === 0) return ''

  const sassEntryAbsPath = resolveWorkspacePackageEntry(dir, 'sass')
  if (!sassEntryAbsPath) {
    warnings.push({
      code: 'sass-not-installed',
      message: 'Sass files were found but the workspace has no installed `sass` package.',
      fix: 'Run dependency install (POST /admin/api/studio/install), which pulls in `sass` if it is a declared dependency.',
    })
    return ''
  }

  const result = await runStyleCompileWorker(dir, { kind: 'sass', sassEntryAbsPath, files }, warnings, 'sass-compile-failed', overrides)
  return result?.css ?? ''
}

// ---------------------------------------------------------------------------
// PostCSS, including Tailwind v3/v4 — Tier 1
// ---------------------------------------------------------------------------

/**
 * v4 has no config-file convention of its own — it's driven entirely by
 * `@import "tailwindcss"` inside a stylesheet (`projectProbe.ts`'s
 * `detectTailwind` already stores that stylesheet's path AS `configPath`
 * precisely because there is no other file to point at). v3's entry is
 * whichever stylesheet carries the `@tailwind` directives; a bare PostCSS
 * pipeline with no Tailwind at all (just e.g. autoprefixer) still needs SOME
 * entry to run against, so it falls back to the first stylesheet found.
 */
function findPostcssEntryStylesheet(dir: string, tailwind: { configPath: string } | null): string | undefined {
  if (tailwind && /\.css$/i.test(tailwind.configPath)) return tailwind.configPath

  const cssFiles = listWorkspaceFiles(dir)
    .filter((f) => /\.css$/i.test(f) && !CSS_MODULE_FILE_RE.test(f))
    .sort()
  const withDirective = cssFiles.find((f) => {
    const text = readCappedFile(join(dir, ...f.split('/')))
    return text !== undefined && /@tailwind\s/.test(text)
  })
  return withDirective ?? cssFiles[0]
}

/**
 * Resolves everything the PARENT process can safely resolve WITHOUT
 * executing workspace code — the `postcss`/`@tailwindcss/postcss` package
 * entries (symlink-containment-checked, `workspacePackageResolve.ts`) and,
 * for the config-file case, a containment-checked absolute path to
 * `postcss.config.*` itself. Named-plugin-map resolution
 * (`{ tailwindcss: {}, autoprefixer: {} }`) can only happen AFTER the config
 * file runs, so that step is deferred to the subprocess — see
 * `styleCompileWorker.ts`'s `resolvePostcssPlugins`.
 */
export async function compilePostcssPipeline(dir: string, profile: ProjectProfile, warnings: ProbeWarning[], overrides: StyleCompileOverrides): Promise<string> {
  const toolchain = profile.styleToolchain
  if (!toolchain.tailwind && !toolchain.postcssConfigPath) return ''

  const postcssEntryAbsPath = resolveWorkspacePackageEntry(dir, 'postcss')
  if (!postcssEntryAbsPath) {
    warnings.push({
      code: 'postcss-not-installed',
      message: 'A PostCSS/Tailwind config was found but the workspace has no installed `postcss` package.',
      fix: 'Run dependency install (POST /admin/api/studio/install), then reload.',
    })
    return ''
  }

  const entryRelPath = findPostcssEntryStylesheet(dir, toolchain.tailwind)
  if (!entryRelPath) {
    warnings.push({
      code: 'tailwind-entry-not-found',
      message: 'No stylesheet with a `@tailwind` directive or `@import "tailwindcss"` was found to run the PostCSS pipeline against.',
      fix: 'Confirm the entry stylesheet is reachable from the workspace root.',
    })
    return ''
  }

  let postcssConfigAbsPath: string | undefined
  let pluginEntryAbsPaths: string[] = []
  if (toolchain.postcssConfigPath) {
    const candidate = join(dir, ...toolchain.postcssConfigPath.split('/'))
    if (!isRealpathContained(candidate, dir)) {
      warnings.push({
        code: 'postcss-config-load-failed',
        message: `${toolchain.postcssConfigPath} resolves outside the project directory (a symlink escape) and was refused.`,
        fix: 'Remove the symlink, or point the config at a file that actually lives inside the project.',
      })
      return ''
    }
    postcssConfigAbsPath = candidate
  } else if (toolchain.tailwind) {
    // v4, no postcss.config: the official integration is `@tailwindcss/postcss`.
    const twPostcssEntry = resolveWorkspacePackageEntry(dir, '@tailwindcss/postcss')
    if (twPostcssEntry) pluginEntryAbsPaths = [twPostcssEntry]
  }

  if (!postcssConfigAbsPath && pluginEntryAbsPaths.length === 0) {
    warnings.push({
      code: 'tailwind-plugin-not-resolved',
      message: "Could not resolve any PostCSS plugins for this project's Tailwind/PostCSS configuration.",
      fix: 'Confirm tailwindcss (and, for v4, @tailwindcss/postcss) is installed in the workspace.',
    })
    return ''
  }

  const result = await runStyleCompileWorker(
    dir,
    { kind: 'postcss', postcssEntryAbsPath, entryRelPath, pluginEntryAbsPaths, postcssConfigAbsPath },
    warnings,
    'postcss-compile-failed',
    overrides,
  )
  return result?.css ?? ''
}
