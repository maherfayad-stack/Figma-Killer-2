/**
 * canonicalPageCheck — the one place a caller that only holds a resolved
 * absolute file path (not an already-parsed `ParsedPage`) reaches
 * `checkCanonicalJsx`. Extracted from `projectTools.ts`'s local
 * `canonicalSummaryFor` (WS-13's `studio_read_file` wiring) so a SECOND
 * caller can reuse the exact same parse-check-summarize sequence instead of
 * growing a slightly different copy.
 *
 * ## Why a second caller exists (A6, STUDIO-FIGMA-PARITY-PLAN.md)
 *
 * `checkCanonicalJsx` was wired only into `studio_read_file` — a tool the
 * in-canvas agent is never offered (`agentToolNames.ts` withholds it in
 * favour of the native `Read`/`Write`/`Edit` the CLI driver grants directly;
 * see that file's own doc comment). So nothing ever ran this check against a
 * page the agent actually wrote: the CLI's native `Write`/`Edit` calls are
 * not server-mediated the way an MCP tool call is, so there is no per-call
 * hook to attach the check to. `studio_screenshot` is: the agent's own
 * prescribed workflow calls it after every write ("LOOK. studio_screenshot
 * after writing, every time" — `systemPrompt.ts`), and it already resolves
 * each requested page to a file. Folding the same check in there re-arms it
 * on the one path guaranteed to run after a real write, without inventing a
 * new interception mechanism this architecture doesn't have.
 *
 * ## Why this builds a WORKSPACE-aware `Project` AND passes `workspaceRoot`
 *
 * `projectTools.ts`'s original `canonicalSummaryFor` called
 * `parsePageFile(resolved, dir)` with no third or fourth argument — which
 * defaults to a brand-new, single-file `ts-morph` `Project` and no
 * `StaticEvalOptions` at all. Confirmed against this repo's own committed
 * `studio-workspace/__canonical-fixture/src/screens/CanonicalScreen.tsx` — a
 * perfectly canonical screen that imports a module-scope const array from a
 * sibling file for `.map` (the ordinary, encouraged shape rule 4/
 * `const-array-map` exists to ALLOW) — that call comes back `isCanonical:
 * false`, a false `const-array-map` VIOLATION. TWO things are needed to fix
 * it, both confirmed by direct testing against that fixture: a `Project` that
 * has the sibling file loaded (`createWorkspaceProject`), AND a
 * `StaticEvalOptions.workspaceRoot` so the evaluator's cross-file import
 * resolution (`resolveRawTextImport`/`resolveImageAssetImport`/the plain
 * identifier-to-module-const path) actually activates — the `Project` alone
 * was NOT sufficient. A self-check that falsely flags the canonical example
 * as broken is worse than no self-check — it teaches the agent to distrust or
 * ignore the signal — so this pays for both, the same way `loadStudioPages`
 * already does on every "read the project" turn, and reuses a caller-supplied
 * `Project` across a batch (`studio_screenshot`, checking several pages in one
 * call) rather than re-scanning the workspace per page.
 */
import { type Project } from 'ts-morph'
import {
  checkCanonicalJsx,
  createWorkspaceProject,
  parsePageFile,
  summarizeCanonicalFindings,
  type CanonicalSummary,
} from '@core/page-parser'

/**
 * `resolved` is the file's real absolute path; `dir` the project root (both
 * already validated by the caller); `relPath` is the project-relative path
 * used only to decide whether this even LOOKS like a page file — a plain
 * component/util/style file degrades to `undefined` (no finding, not a false
 * "canonical") rather than being force-parsed as a screen.
 *
 * `project` — pass an already-built `createWorkspaceProject(dir)` when
 * checking several files against the SAME project in one call (`studio_
 * screenshot`'s batch), so the whole-workspace scan happens once, not once
 * per file. Omit it for a single, standalone check (`studio_read_file`) —
 * this builds its own.
 *
 * Never throws: `parsePageFile` never throws on its own (a guard trip yields
 * an empty page), and the `try/catch` here is belt-and-braces for the same
 * reason `projectTools.ts`'s original version carried one — a self-check must
 * never be able to fail the call it rides on.
 */
export function canonicalSummaryForFile(
  resolved: string,
  dir: string,
  relPath: string,
  project?: Project,
): CanonicalSummary | undefined {
  if (!/\.(tsx|jsx)$/.test(relPath)) return undefined
  try {
    const parsed = parsePageFile(resolved, dir, project ?? createWorkspaceProject(dir), { workspaceRoot: dir })
    const findings = checkCanonicalJsx({ page: parsed })
    return summarizeCanonicalFindings(findings)
  } catch {
    return undefined
  }
}
