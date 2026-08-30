/**
 * typecheck — runs the PROJECT's OWN installed `typescript` compiler
 * (`tsc --noEmit`) against a Studio workspace and turns its output into
 * structured diagnostics (`tscDiagnostics.ts`). The gap this closes: the
 * in-canvas agent writes `.tsx` source directly and had no way to confirm it
 * actually compiles — `studio_compare`/`studio_screenshot` can pass on a
 * screen that never typechecks.
 *
 * **Never falls back to Studio's own `tsc`.** The user's project can target a
 * different TypeScript version/config than Studio's own devDependency, and a
 * pass against the wrong compiler is worse than an honest "not available" —
 * it would tell the agent code is fine when the project's OWN toolchain would
 * reject it (or vice versa). `resolveProjectTscPath` resolves
 * `<dir>/node_modules/typescript/bin/tsc` only, symlink-containment-checked
 * against `dir` the same way `resolveWorkspacePackageEntry`
 * (`workspacePackageResolve.ts`) checks every other workspace-resolved
 * binary — never the host admin server's own `node_modules`.
 *
 * **Same trust-tier risk class as `studio_install_deps`.** Running the
 * project's own `tsc` executes a binary the workspace's `node_modules`
 * supplied — this module runs it, but the CALLER (the MCP tool) is
 * responsible for asking `readStudioMeta(dir).trust` and refusing at Tier 0
 * BEFORE calling `runProjectTypecheck`, exactly like `installDepsTool` does.
 * This module does not re-check trust itself, for the same reason
 * `compileSass`/`compilePostcssPipeline` don't: it is a mechanism, not a
 * policy — the policy decision belongs at the one call site that can also
 * decide what message to show, and duplicating it here would let it drift.
 *
 * **Never mutates the project.** `--incremental false` is always passed on
 * the command line, overriding a project's own `tsconfig.json` if it sets
 * `"incremental": true` — without it, `tsc` writes a `.tsbuildinfo` file into
 * the project even with `--noEmit`, which measured against a real tsconfig
 * (`compilerOptions.incremental: true`) actually happens. A read-only
 * diagnostic tool leaving a build artefact in the user's tracked repo would
 * be a surprise no docstring excuses.
 *
 * **`sec-01` subprocess posture**, same as `styleCompileTier1.ts`: argv
 * array (never a shell string), `cwd` = the workspace (never the Studio repo
 * root), `env` = `minimalSubprocessEnv()` (no secrets forwarded), capped
 * stdout/stderr, killed on `TYPECHECK_TIMEOUT_MS`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  minimalSubprocessEnv,
  runCappedSubprocess,
  type SubprocessSpawnFn,
} from './subprocessRunner'
import { isRealpathContained } from './workspacePackageResolve'
import { parseTscDiagnostics, type TscDiagnostic } from './tscDiagnostics'

/**
 * A cold `tsc --noEmit` on a real, uncached project can run well past a
 * minute — but this runs synchronously inside one MCP tool call (unlike
 * `studio_install_deps`, which is a polled background job), so it still
 * needs a hard ceiling. 2 minutes is generous headroom for a mid-size
 * project without leaving a single tool call unbounded.
 */
export const TYPECHECK_TIMEOUT_MS = 120_000
/** A large project's full diagnostic dump can run long; generous but bounded — matches the order of magnitude `styleCompileTier1.ts` allows compiled CSS. */
const TYPECHECK_MAX_STDOUT_BYTES = 4 * 1024 * 1024
/** stderr is only ever a crash/version banner here — diagnostics come through stdout. */
const TYPECHECK_MAX_STDERR_BYTES = 64 * 1024

export interface TypecheckOverrides {
  /** Test seam — same shape `styleCompileTier1.ts`'s `StyleCompileOverrides` uses. Never touched by the real call path. */
  spawn?: SubprocessSpawnFn
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export type TypecheckNotAvailableReason = 'typescript-not-installed' | 'no-tsconfig'

export interface TypecheckNotAvailable {
  ok: false
  available: false
  reason: TypecheckNotAvailableReason
  message: string
  fix: string
}

export interface TypecheckTimeout {
  ok: false
  timedOut: true
  message: string
  /** Whatever `tsc` had already printed before it was killed — real diagnostics, just possibly incomplete. Never discarded just because the run didn't finish. */
  partialDiagnostics: TscDiagnostic[]
}

export interface TypecheckInvocationError {
  ok: false
  code: 'tsc-invocation-error'
  message: string
  /** Capped stderr (or stdout, when stderr was empty) — enough to show the agent what actually went wrong without risking an unbounded payload. */
  outputExcerpt: string
  exitCode: number | null
}

export interface TypecheckRunSuccess {
  ok: true
  timedOut: false
  exitCode: number | null
  /** Every diagnostic `tsc` reported, in `tsc`'s own order — unfiltered, uncapped. The MCP tool layer owns scope filtering and the response cap, the same split `qualityCheck.ts` keeps from `qualityAudit.ts`. */
  diagnostics: TscDiagnostic[]
}

export type TypecheckRunResult = TypecheckNotAvailable | TypecheckTimeout | TypecheckInvocationError | TypecheckRunSuccess

/**
 * `<dir>/node_modules/typescript/bin/tsc` — TypeScript's package.json
 * publishes this as its `tsc` bin entry; `resolveWorkspacePackageEntry`
 * (which resolves a package's `main` field) is the wrong tool here, because
 * `typescript`'s `main` is the compiler API module, not the CLI script.
 * Symlink-containment-checked against `dir` the same way every other
 * workspace-resolved binary in this codebase is (`isRealpathContained`) — a
 * repo pulled from GitHub can contain a `node_modules` entry that is
 * actually a symlink escaping the workspace.
 */
export function resolveProjectTscPath(dir: string): string | undefined {
  const tscPath = join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tscPath)) return undefined
  return isRealpathContained(tscPath, dir) ? tscPath : undefined
}

/**
 * Runs the project's own `tsc --noEmit` and returns a structured result —
 * never throws for an expected condition (no typescript installed, no
 * tsconfig, a timeout, a broken toolchain). See module doc for the full
 * contract, including the caller's own trust-tier responsibility.
 */
export async function runProjectTypecheck(dir: string, overrides: TypecheckOverrides = {}): Promise<TypecheckRunResult> {
  // `tsc` with no tsconfig.json in `cwd` and no file arguments prints its own
  // CLI help text (exit 1) instead of doing anything — indistinguishable from
  // a real failure unless checked for up front.
  if (!existsSync(join(dir, 'tsconfig.json'))) {
    return {
      ok: false,
      available: false,
      reason: 'no-tsconfig',
      message: 'This project has no tsconfig.json at its root, so there is nothing for tsc to check against.',
      fix: 'Add a tsconfig.json at the project root (a minimal one is enough), then retry.',
    }
  }

  const tscPath = resolveProjectTscPath(dir)
  if (!tscPath) {
    return {
      ok: false,
      available: false,
      reason: 'typescript-not-installed',
      message: 'This project has no installed `typescript` package (node_modules/typescript) — its own tsc cannot run.',
      fix: 'Call studio_install_deps to install the project\'s declared dependencies (typescript must be one of them, directly or as a peer of the framework), then retry studio_typecheck.',
    }
  }

  const result = await runCappedSubprocess(
    [process.execPath, tscPath, '--noEmit', '--pretty', 'false', '--incremental', 'false'],
    {
      cwd: dir,
      env: minimalSubprocessEnv(),
      timeoutMs: TYPECHECK_TIMEOUT_MS,
      maxStdoutBytes: TYPECHECK_MAX_STDOUT_BYTES,
      maxStderrBytes: TYPECHECK_MAX_STDERR_BYTES,
      spawn: overrides.spawn,
      setTimeoutImpl: overrides.setTimeoutImpl,
      clearTimeoutImpl: overrides.clearTimeoutImpl,
    },
  )

  const diagnostics = parseTscDiagnostics(result.stdout)

  if (result.timedOut) {
    return {
      ok: false,
      timedOut: true,
      message: `Type-checking did not finish within ${TYPECHECK_TIMEOUT_MS}ms and was killed. partialDiagnostics is only what tsc had already printed before that — files it had not reached yet are unknown, not clean.`,
      partialDiagnostics: diagnostics,
    }
  }

  // A real compile always reports SOME diagnostic on a non-zero exit, or
  // exits 0. Anything else (a broken tsconfig `extends` chain, a crashed
  // process) is a toolchain failure, not a code error — surfacing it as
  // "pass: true" or as an empty diagnostic list would be a lie.
  if (diagnostics.length === 0 && result.exitCode !== 0) {
    return {
      ok: false,
      code: 'tsc-invocation-error',
      message: `tsc exited with code ${result.exitCode} without reporting any parseable diagnostic — this usually means the project's tsconfig.json or toolchain itself is broken, not a type error in the code.`,
      outputExcerpt: (result.stderr || result.stdout).slice(0, 2000),
      exitCode: result.exitCode,
    }
  }

  return { ok: true, timedOut: false, exitCode: result.exitCode, diagnostics }
}
