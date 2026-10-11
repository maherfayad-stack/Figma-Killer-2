/**
 * `studio_lint` — runs the PROJECT's OWN ESLint and returns structured
 * diagnostics (AI-21). The lint counterpart of `studio_typecheck`: the code
 * compiles, but does it follow the rules this project set for itself
 * (hooks rules, a11y rules, import order)?
 *
 * The run itself is `runProjectLint` (`handlers/studio/projectLint.ts`), which
 * documents how the process is started and what it is never given. This file
 * owns what the engine deliberately does not: both gates, the containment of
 * the caller's `paths`, and the response cap.
 *
 * ## Two gates, because a lint run executes project code
 *
 * An ESLint config is a JavaScript module the project wrote, and its plugins
 * are packages the project installed; loading them runs them. That is the
 * `studio_render_reference` risk class, not the `studio_typecheck` one, so
 * this tool carries the same two gates:
 *
 *   1. `requiredCapabilities: ['studio.run.project']` (plus `requiresWrite`),
 *      enforced by `toolAllowedForCapabilities` before the handler runs: may
 *      this caller run project code at all.
 *   2. `checkTrustTier(dir, 'run-project')`: may THIS project be run. Anything
 *      below Tier 2 refuses with `trust-tier-required`, and the agent may never
 *      promote a project itself (`agentWriteScope.ts` refuses `.studio/`).
 *
 * `studio-tier2-two-gates.test.ts` holds both in place.
 *
 * ## Nothing changes on disk
 *
 * No `--fix`, no cache file — so `sideEffects: 'none'`: the tool loop runs a
 * re-lint after a fix instead of answering it with the pre-fix report.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveAppRoot } from '../../../../handlers/studio/appRoot'
import { TRUST_TIER_REQUIRED_CODE, checkTrustTier } from '../../../../handlers/studio/trustGate'
import { resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { runProjectLint, type LintDiagnostic, type LintOverrides } from '../../../../handlers/studio/projectLint'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { pathRefusal } from './fileReadTools'

/** Same ceiling as `studio_typecheck`'s. */
const MAX_DIAGNOSTICS_RETURNED = 60
const MAX_LINT_PATHS = 50

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project open in Studio; omit it unless you mean a DIFFERENT project.' }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
        maxItems: MAX_LINT_PATHS,
        description: 'Project-relative files or folders to lint, e.g. ["pages/Checkout.tsx"]. Omit to lint the whole app. Unlike studio_typecheck, this narrows what runs, not only what comes back.',
      }),
    ),
  },
  { additionalProperties: false },
)

/** Errors first, then by file and position — the order a fix pass wants. */
function sortDiagnostics(diagnostics: readonly LintDiagnostic[]): LintDiagnostic[] {
  return [...diagnostics].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })
}

/** Test seam, same shape as `studio_typecheck`'s. */
export function createStudioLintTool(overrides: LintOverrides = {}): AiTool {
  return {
    name: 'studio_lint',
    scope: 'shared',
    execution: 'server',
    sideEffects: 'none',
    requiresWrite: true,
    requiredCapabilities: ['studio.run.project'],
    description:
      'Lint with the project\'s OWN ESLint and its own config: does the code you wrote follow the rules this project set (hooks, a11y, imports)? paths narrows what is linted; omit it for the whole app. Returns { ok:true, pass, errorCount, warningCount, diagnostics[{ file, line, column, severity, ruleId, message }], truncated, configFile }; pass means no errors (warnings allowed). It runs the project\'s config and plugins, so it is gated twice: the caller needs studio.run.project AND the project must be at \'run-project\' trust — otherwise trust-tier-required (ask the user to promote it; never promote it yourself). Other refusals: eslint-not-installed, no-eslint-config (the project has no lint rules; never add a config to pass), lint-invocation-error (a broken config, not your code), lint-timed-out. Fix errors, then lint again.',
    inputSchema: InputSchema,
    handler: async (input, ctx: ToolContext) => {
      const { dir: dirInput, paths } = input as { dir?: string; paths?: string[] }
      const dir = resolveToolProjectDir(dirInput, ctx)

      // Gate 2 of 2. Gate 1 (`studio.run.project`) already ran in
      // `toolAllowedForCapabilities`. Read off the PROJECT dir, never the app
      // root: `.studio/meta.json` lives at the project root (`trustGate.ts`).
      const trust = checkTrustTier(dir, 'run-project')
      if (!trust.ok) {
        return toolRefusal(
          TRUST_TIER_REQUIRED_CODE,
          `This project is at "${trust.trust}" trust, and linting runs its own ESLint config and plugins, which needs the highest tier ("run-project").`,
          {
            remedy: 'Ask the user to promote the project in Studio, then lint again; you may not promote it yourself, so this call keeps refusing until they do.',
            details: { trust: trust.trust, requiredTrust: trust.required },
          },
        )
      }

      // Every target is contained BEFORE it becomes an argument: an absolute,
      // contained path can never be read by ESLint as a flag.
      const targets: string[] = []
      for (const raw of paths ?? []) {
        const target = resolveAgentFilePath(dir, raw, 'read')
        if (!target.ok) return pathRefusal(target)
        targets.push(target.abs)
      }

      const result = await runProjectLint(resolveAppRoot(dir), dir, targets, overrides)
      if (!result.ok) {
        if (result.code === 'lint-timed-out') {
          return toolRefusal('lint-timed-out', result.message, { remedy: 'Lint fewer paths at a time.' })
        }
        if (result.code === 'lint-invocation-error') {
          return toolRefusal('lint-invocation-error', result.message, {
            remedy: 'This is the project\'s lint setup, not the code you wrote. Report it rather than editing files in response.',
            details: { outputExcerpt: result.outputExcerpt, exitCode: result.exitCode },
          })
        }
        return toolRefusal(result.code, result.message, { remedy: result.remedy })
      }

      const sorted = sortDiagnostics(result.diagnostics)
      const errorCount = sorted.filter((d) => d.severity === 'error').length
      const diagnostics = sorted.slice(0, MAX_DIAGNOSTICS_RETURNED)
      return {
        ok: true,
        pass: errorCount === 0,
        errorCount,
        warningCount: sorted.length - errorCount,
        diagnostics,
        truncated: sorted.length > diagnostics.length,
        configFile: result.configFile,
        scope: targets.length > 0 ? 'paths' : 'project',
      }
    },
  }
}

export const studioLintMcpTools: AiTool[] = [createStudioLintTool()]
