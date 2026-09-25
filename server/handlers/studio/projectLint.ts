/**
 * projectLint — runs the PROJECT's OWN installed ESLint against a Studio
 * workspace and turns its JSON report into structured diagnostics (AI-21).
 *
 * The mechanism only. The trust-tier refusal, the path containment of the
 * caller's `paths`, and the response cap belong to the one call site that can
 * also word them (`server/ai/mcp/tools/studio/lintTool.ts`) — the same split
 * `typecheck.ts` keeps with `studio_typecheck`.
 *
 * ## What running a linter executes
 *
 * More than `tsc` does. An ESLint config is a JavaScript module the project
 * wrote, and every plugin it names is a package the project installed; both
 * run in-process the moment ESLint loads them. That is why the tool is Tier 2
 * (`run-project`) and gated by `studio.run.project`, like
 * `studio_render_reference`, not Tier 1 like `studio_typecheck`.
 *
 * ## How the process is started, and what it is never given
 *
 *   - **The project's own ESLint, run directly.** The `eslint` bin from the
 *     project's `node_modules` (`resolveProjectPackageBin`, real-path contained),
 *     started with a JavaScript runtime. Never `<pm> run lint`, which would
 *     also run the repository's `prelint`/`postlint` scripts; never `npx`,
 *     which can fetch a package the project never installed. The same move the
 *     security-hardening bundle made for the dev server (`viteLaunch.ts`).
 *   - **The config is pinned.** Flat-config ESLint looks for
 *     `eslint.config.*` from its cwd UPWARD — and a project under
 *     `studio-workspace/` sits inside Studio's own repository, whose own config
 *     would silently answer for a project that has none. So the config must be
 *     found between the app root and the project directory, and it is passed
 *     with `--config`. No config there is a refusal, not a guess.
 *   - **Nothing is written.** No `--fix`, no `--cache`, no `--output-file`:
 *     the report goes to stdout.
 *   - **Every argument is Studio's.** Lint targets are absolute paths the
 *     caller already contained (an absolute path never starts with `-`, so a
 *     target cannot become a flag).
 *   - **`sec-01` posture.** argv array, never a shell; `cwd` = the app root;
 *     `env` = `minimalSubprocessEnv()`; stdout/stderr capped; killed at
 *     {@link LINT_TIMEOUT_MS}.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { minimalSubprocessEnv, runCappedSubprocess, type SubprocessSpawnFn } from './subprocessRunner'
import { appRootToProjectDir, packageBinRuntime, resolveProjectPackageBin } from './projectPackageBin'
import { isRealpathContained } from './workspacePackageResolve'

/** Same ceiling as `TYPECHECK_TIMEOUT_MS`: one synchronous tool call, bounded. */
export const LINT_TIMEOUT_MS = 120_000
/** ESLint's JSON report carries each problem file's source, so it runs larger than tsc's. */
const LINT_MAX_STDOUT_BYTES = 8 * 1024 * 1024
const LINT_MAX_STDERR_BYTES = 64 * 1024

const FLAT_CONFIG_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts']
const LEGACY_CONFIG_FILES = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc']

export interface LintOverrides {
  /** Test seam — never set on the real call path. */
  spawn?: SubprocessSpawnFn
  runtime?: string
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface LintDiagnostic {
  /** Project-relative, POSIX. */
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  /** `null` for a parse error (ESLint reports it without a rule). */
  ruleId: string | null
  message: string
}

export type LintRunResult =
  | { ok: false; code: 'eslint-not-installed' | 'no-eslint-config'; message: string; remedy: string }
  | { ok: false; code: 'lint-timed-out'; message: string }
  | { ok: false; code: 'lint-invocation-error'; message: string; outputExcerpt: string; exitCode: number | null }
  | { ok: true; exitCode: number | null; configFile: string; diagnostics: LintDiagnostic[] }

const EslintMessageSchema = Type.Object({
  ruleId: Type.Union([Type.String(), Type.Null()]),
  severity: Type.Number(),
  message: Type.String(),
  line: Type.Optional(Type.Number()),
  column: Type.Optional(Type.Number()),
})

const EslintReportSchema = Type.Array(
  Type.Object({
    filePath: Type.String(),
    messages: Type.Array(EslintMessageSchema),
  }),
)

interface EslintConfigLocation {
  readonly file: string
  /** `flat`: eslint.config.*; `legacy-file`: .eslintrc*; `legacy-package`: package.json's `eslintConfig`. */
  readonly kind: 'flat' | 'legacy-file' | 'legacy-package'
}

/** A `package.json` that configures ESLint inline (the legacy `eslintConfig` key). */
const PackageEslintConfigSchema = Type.Object({ eslintConfig: Type.Optional(Type.Unknown()) })

/**
 * The config ESLint should use: the nearest flat config between the app root
 * and the project directory, else the nearest legacy one. Real-path contained
 * in the project, or it does not count.
 */
export function findProjectEslintConfig(appRoot: string, projectDir: string): EslintConfigLocation | null {
  const dirs = appRootToProjectDir(appRoot, projectDir)
  for (const dir of dirs) {
    for (const name of FLAT_CONFIG_FILES) {
      const file = join(dir, name)
      if (existsSync(file) && isRealpathContained(file, projectDir)) return { file, kind: 'flat' }
    }
  }
  for (const dir of dirs) {
    for (const name of LEGACY_CONFIG_FILES) {
      const file = join(dir, name)
      if (existsSync(file) && isRealpathContained(file, projectDir)) return { file, kind: 'legacy-file' }
    }
    const pkg = join(dir, 'package.json')
    if (!existsSync(pkg) || !isRealpathContained(pkg, projectDir)) continue
    const parsed = safeParseJson(readFileSync(pkg, 'utf8'), PackageEslintConfigSchema)
    if (parsed.ok && parsed.value.eslintConfig !== undefined) return { file: pkg, kind: 'legacy-package' }
  }
  return null
}

function projectRelative(projectDir: string, abs: string): string {
  return relative(projectDir, abs).split(sep).join('/')
}

/**
 * Lint `targets` (absolute paths the caller already contained; empty means the
 * whole app root) with the project's own ESLint. Never throws for an expected
 * condition. See the module doc.
 */
export async function runProjectLint(
  appRoot: string,
  projectDir: string,
  targets: readonly string[],
  overrides: LintOverrides = {},
): Promise<LintRunResult> {
  const bin = resolveProjectPackageBin(appRoot, projectDir, 'eslint', 'eslint')
  if (bin === null) {
    return {
      ok: false,
      code: 'eslint-not-installed',
      message: 'This project has no installed eslint package (node_modules/eslint), so its own linter cannot run.',
      remedy: 'If the project declares eslint, install its dependencies (studio_install_deps) and lint again. If it does not use ESLint, there is nothing to lint: rely on studio_typecheck.',
    }
  }
  const config = findProjectEslintConfig(appRoot, projectDir)
  if (config === null) {
    return {
      ok: false,
      code: 'no-eslint-config',
      message: 'This project has ESLint installed but no ESLint config (eslint.config.* or .eslintrc*) inside it, so there are no project rules to check against.',
      remedy: 'Do not add a config yourself to make this pass; the project has no lint rules. Rely on studio_typecheck.',
    }
  }

  // A legacy `.eslintrc*` is pinned the same way, which also stops ESLint's
  // cascade at it. `package.json`'s `eslintConfig` cannot be passed as a file
  // (`--config` would read the whole manifest as a config), so that one case is
  // left to ESLint's own lookup, which starts at the app root.
  const configArgs = config.kind === 'flat'
    ? ['--config', config.file]
    : config.kind === 'legacy-file' ? ['--no-eslintrc', '--config', config.file] : []
  const argv = [
    overrides.runtime ?? packageBinRuntime(),
    bin,
    '--format', 'json',
    '--no-error-on-unmatched-pattern',
    ...configArgs,
    ...(targets.length > 0 ? targets : [appRoot]),
  ]
  // ESLint 9 reads a legacy config only when told to.
  const env = minimalSubprocessEnv([], config.kind === 'flat' ? {} : { ESLINT_USE_FLAT_CONFIG: 'false' })
  const result = await runCappedSubprocess(argv, {
    cwd: appRoot,
    env,
    timeoutMs: LINT_TIMEOUT_MS,
    maxStdoutBytes: LINT_MAX_STDOUT_BYTES,
    maxStderrBytes: LINT_MAX_STDERR_BYTES,
    spawn: overrides.spawn,
    setTimeoutImpl: overrides.setTimeoutImpl,
    clearTimeoutImpl: overrides.clearTimeoutImpl,
  })

  if (result.timedOut) {
    return { ok: false, code: 'lint-timed-out', message: `ESLint did not finish within ${LINT_TIMEOUT_MS}ms and was killed; nothing it found is known.` }
  }
  const configFile = projectRelative(projectDir, config.file)
  // Exit 2 is ESLint's own "the run itself failed" (a config error, a missing
  // plugin). A truncated or unparsable report is the same honest answer: no
  // verdict, never an empty diagnostic list that reads as a pass.
  const parsed = result.stdoutTruncated ? null : safeParseJson(result.stdout, EslintReportSchema)
  if (result.exitCode === 2 || parsed === null || !parsed.ok) {
    return {
      ok: false,
      code: 'lint-invocation-error',
      message: result.stdoutTruncated
        ? 'ESLint reported more than Studio reads in one call. Lint fewer paths at a time.'
        : `ESLint exited with code ${result.exitCode} without a readable report — usually the project's ESLint config or a plugin it names is broken, not the code.`,
      outputExcerpt: (result.stderr || result.stdout).slice(0, 2000),
      exitCode: result.exitCode,
    }
  }

  const diagnostics: LintDiagnostic[] = []
  for (const file of parsed.value) {
    for (const message of file.messages) {
      diagnostics.push({
        file: projectRelative(projectDir, file.filePath),
        line: message.line ?? 1,
        column: message.column ?? 1,
        severity: message.severity >= 2 ? 'error' : 'warning',
        ruleId: message.ruleId,
        message: message.message,
      })
    }
  }
  return { ok: true, exitCode: result.exitCode, configFile, diagnostics }
}
