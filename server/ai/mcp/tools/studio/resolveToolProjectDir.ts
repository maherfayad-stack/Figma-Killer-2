/**
 * resolveToolProjectDir — the one place a Studio tool turns its optional `dir`
 * argument into a real project directory.
 *
 * Every Studio tool documents `dir` as optional, so an agent routinely omits
 * it. `resolveProjectDir(undefined)` then answers with the first project in
 * alphabetical order, which is right only when there is one project and is
 * silently wrong the moment there are two: the agent reads and writes
 * `untitled` while the human is looking at `untitled-2`, with every call
 * succeeding and nothing naming the mismatch.
 *
 * This threads the turn's own open workspace (`ctx.workspaceDir`, bound per
 * connector by `connectorWorkspace.ts`) in as the default instead. An
 * explicitly-passed `dir` still wins — the fallback chain is:
 *
 *   explicit `dir` → this turn's open project → first project alphabetically
 *
 * Import this rather than `resolveProjectDir` in any tool handler that has a
 * `ctx`; `studio-tool-project-dir.test.ts` gates that.
 */
import { resolveProjectDir } from '../../../../handlers/studioProjects'

/**
 * `ctx` is typed structurally rather than as the full `ToolContext` so a
 * caller can pass either it or a `ToolContextBase` — the two carry the same
 * field, and this function needs nothing else from either.
 */
export function resolveToolProjectDir(
  requested: string | null | undefined,
  ctx: { readonly workspaceDir?: string },
): string {
  return resolveProjectDir(requested ?? ctx.workspaceDir)
}
