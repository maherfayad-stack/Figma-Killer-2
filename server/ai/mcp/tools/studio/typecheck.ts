/**
 * `studio_typecheck` — runs the PROJECT's OWN `tsc --noEmit` and returns
 * structured diagnostics. Closes the single largest verification gap in the
 * agent's toolset: the in-canvas agent writes `.tsx` directly with no shell
 * (`systemPrompt.ts`: "There is no shell here. No Bash, no subagents.") and,
 * before this tool, had no way to confirm what it wrote actually compiles —
 * `studio_compare`/`studio_screenshot` can both pass on a screen that never
 * typechecks.
 *
 * The compiler run itself lives in `../../../../handlers/studio/typecheck.ts`
 * (`runProjectTypecheck` + `resolveProjectTscPath`) and the plain-text parse
 * in `../../../../handlers/studio/tscDiagnostics.ts` — this file owns exactly
 * three things the engine deliberately does NOT: the trust-tier refusal, the
 * `paths` scope filter, and the response cap. Same split
 * `qualityCheck.ts`/`qualityAudit.ts` keep.
 *
 * **Trust tier — same risk class and same gate as `studio_install_deps`
 * (`projectTools.ts`).** Running the project's own `tsc` executes a binary
 * the workspace's `node_modules` supplied; that is exactly the risk
 * `installDepsTool` already refuses at Tier 0 (`static`) for. This tool asks
 * the SAME `.studio/meta.json` `trust` field, refuses with the SAME
 * `trust-tier-required` code and posture (the agent may ask the user to
 * promote the project; it may never promote it itself — there is no
 * permission-mode notion to bypass this with), and — like `installDepsTool`
 * — is gated by BOTH `mutates: true` (so `ai.tools.write` is required) and
 * `requiredCapabilities: ['studio.write']`. Neither axis is looser than
 * `studio_install_deps`'s; a connector that cannot install dependencies
 * cannot typecheck either.
 *
 * **Scope filtering, not a subset compile.** `tsc` cannot check a subset of
 * a project without losing its own project config (path aliases, `strict`,
 * `jsx`, …), so `paths` never changes what actually runs — the FULL project
 * is always type-checked, and `paths` only filters which diagnostics come
 * back. The response always says which mode ran (`scope: 'project' |
 * 'filtered'`) and, when filtered, how many diagnostics exist outside that
 * filter — never silently hiding them.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { readStudioMeta } from '../../../../handlers/studio/studioMeta'
import { runProjectTypecheck, type TypecheckRunResult } from '../../../../handlers/studio/typecheck'
import type { TscDiagnostic } from '../../../../handlers/studio/tscDiagnostics'
import { resolveToolProjectDir } from './resolveToolProjectDir'

/** Same precedent as `qualityCheck.ts`'s `MAX_FINDINGS_RETURNED` — far above any real single-project diagnostic count, bounds an already-broken project from blowing the response. */
const MAX_DIAGNOSTICS_RETURNED = 60

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description:
          'Project-relative POSIX paths to restrict the RETURNED diagnostics to (e.g. "src/screens/Checkout.tsx", or just "Checkout.tsx" — a suffix match on the reported path also works). The whole project is always type-checked regardless — tsc cannot check a subset without losing project config (path aliases, strict mode, jsx, …) — this only filters what comes back. Omit to see every diagnostic in the project.',
      }),
    ),
  },
  { additionalProperties: false },
)

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function diagnosticMatchesRequestedPaths(diagnosticFile: string, requested: readonly string[]): boolean {
  const normalizedDiagnostic = normalizeRelPath(diagnosticFile)
  return requested.some((raw) => {
    const normalizedRequest = normalizeRelPath(raw)
    return normalizedDiagnostic === normalizedRequest || normalizedDiagnostic.endsWith(`/${normalizedRequest}`)
  })
}

/** Errors before warnings (the actionable-first ordering the tool description promises), then grouped by file so fixing one file's diagnostics together is easy, then by position within the file. */
function sortDiagnostics(diagnostics: readonly TscDiagnostic[]): TscDiagnostic[] {
  return [...diagnostics].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })
}

/**
 * Shared by both the success path and the timeout path (timeout still
 * returns whatever `tsc` had already printed — see `typecheck.ts`'s
 * `partialDiagnostics` doc) so scope filtering, sorting, and the cap behave
 * identically regardless of how the run ended.
 */
function buildDiagnosticsPayload(all: readonly TscDiagnostic[], requestedPaths: readonly string[] | undefined) {
  const sorted = sortDiagnostics(all)
  const scope: 'project' | 'filtered' = requestedPaths && requestedPaths.length > 0 ? 'filtered' : 'project'
  const scoped = scope === 'filtered' ? sorted.filter((d) => diagnosticMatchesRequestedPaths(d.file, requestedPaths!)) : sorted
  const diagnostics = scoped.slice(0, MAX_DIAGNOSTICS_RETURNED)
  const truncated = scoped.length > diagnostics.length

  const payload: {
    scope: 'project' | 'filtered'
    pass: boolean
    diagnostics: TscDiagnostic[]
    diagnosticCount: number
    totalDiagnosticCount: number
    truncated: boolean
    requestedPaths?: string[]
    note?: string
  } = {
    scope,
    pass: scoped.length === 0,
    diagnostics,
    diagnosticCount: scoped.length,
    totalDiagnosticCount: sorted.length,
    truncated,
  }

  if (scope === 'filtered') {
    payload.requestedPaths = [...requestedPaths!]
    const elsewhereCount = sorted.length - scoped.length
    payload.note = elsewhereCount > 0
      ? `${elsewhereCount} diagnostic(s) exist elsewhere in the project, outside the requested path(s) — they are NOT included above. This result covers only the requested scope, not the whole project. Call studio_typecheck with no paths to see everything.`
      : 'No diagnostics matched the requested path(s). This says nothing about the rest of the project — call studio_typecheck with no paths to see everything.'
  }

  return payload
}

const studioTypecheckTool: AiTool = {
  name: 'studio_typecheck',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Type-check the project with ITS OWN installed tsc (never Studio\'s) — the one verification studio_compare/studio_screenshot cannot give you: whether the code you just wrote actually compiles. Always type-checks the WHOLE project (tsc cannot check a subset without losing project config); pass `paths` to filter which diagnostics come BACK, not what gets checked — the response always names which mode ran (scope: "project" | "filtered") and, when filtered, how many diagnostics exist outside it, so nothing is silently hidden. Returns { ok:true, pass, scope, diagnostics:[{file,line,column,severity,code,message}], diagnosticCount, totalDiagnosticCount, truncated }, or a structured, non-throwing failure: trust-tier-required (Tier 0 projects refuse — ask the user to promote, never promote yourself), available:false with reason "typescript-not-installed"/"no-tsconfig" and a fix, or timedOut:true with whatever partial diagnostics tsc had already printed. Requires studio.write. Call this after every .ts/.tsx/.jsx write or edit — a passing studio_compare on code that does not compile is not verification.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, paths } = input as { dir?: string; paths?: string[] }
    const dir = resolveToolProjectDir(dirInput, ctx)

    // WS-12 §2.3 posture, identical to studio_install_deps: refuse at the
    // tool's own authorization boundary, off the persisted trust field only —
    // there is no permission mode this check could be asked to bypass.
    const trust = readStudioMeta(dir).trust ?? 'static'
    if (trust === 'static') {
      return {
        ok: false,
        code: 'trust-tier-required',
        error: 'This project is at Tier 0 (static) trust, which runs nothing. Ask the user to promote the project before type-checking it — you may not promote it yourself.',
      }
    }

    const result: TypecheckRunResult = await runProjectTypecheck(dir)

    if (!result.ok) {
      if ('available' in result) {
        // typescript-not-installed / no-tsconfig — clean, actionable, not a throw.
        return result
      }
      if ('timedOut' in result && result.timedOut) {
        // `pass` from buildDiagnosticsPayload reflects only what tsc printed
        // BEFORE it was killed — an incomplete run must never report pass:true
        // just because no error had surfaced yet in the files tsc had reached.
        return {
          ok: false,
          timedOut: true,
          message: result.message,
          ...buildDiagnosticsPayload(result.partialDiagnostics, paths),
          pass: false,
        }
      }
      // tsc-invocation-error — a broken toolchain/tsconfig, not a code error.
      return result
    }

    return { ok: true, exitCode: result.exitCode, ...buildDiagnosticsPayload(result.diagnostics, paths) }
  },
}

export const studioTypecheckMcpTools: AiTool[] = [studioTypecheckTool]
