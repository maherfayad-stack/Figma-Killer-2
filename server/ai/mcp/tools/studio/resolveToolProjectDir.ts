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
 * connector by `connectorWorkspace.ts`) in as the default instead:
 *
 *   explicit `dir` → this turn's open project → first project alphabetically
 *
 * Import this rather than `resolveProjectDir` in any tool handler that has a
 * `ctx`; `studio-tool-project-dir.test.ts` gates that.
 *
 * ## Why a bound connector's explicit `dir` is REFUSED (W10, sec)
 *
 * `resolveProjectDir` now containment-checks against `studio-workspace/`, so
 * no `dir` can leave the workspace at all. That still leaves the sideways
 * move: the in-canvas agent, running a turn the user started in project A,
 * passing `dir: <project B>` and editing a project the user is not looking
 * at. A bound connector is not a general-purpose client — it exists for
 * exactly one turn, about exactly one open project, and `chat.ts` has already
 * validated which one. So for a bound connector an explicit `dir` may only
 * ever NAME that project (which is useful — it is how a careful agent is
 * explicit) and never a different one.
 *
 * An UNBOUND connector — an external MCP client (Claude Code, a remote agent)
 * with no open editor tab behind it — keeps the permissive behaviour: it has
 * no `ctx.workspaceDir` to contradict, and naming the project it wants is the
 * only way it can address one at all.
 */
import { realpathSync } from 'node:fs'
import { resolveProjectDir } from '../../../../handlers/studioProjects'

/**
 * Thrown when a workspace-BOUND connector passes a `dir` that is not the
 * project its turn is about. Named so the tool error the agent reads says
 * which two projects disagreed, rather than failing somewhere deeper with a
 * message about a file it should never have been reading.
 */
export class ProjectDirMismatchError extends Error {
  readonly requestedDir: string
  readonly workspaceDir: string

  constructor(requestedDir: string, workspaceDir: string) {
    super(
      `This turn is about the project at "${workspaceDir}", so it cannot operate on "${requestedDir}". `
        + 'Omit `dir` (it defaults to the open project), or ask the user to open that project first.',
    )
    this.name = 'ProjectDirMismatchError'
    this.requestedDir = requestedDir
    this.workspaceDir = workspaceDir
  }
}

/** Symlink-resolved equality, so two spellings of one project (a symlinked workspace root, a trailing `/.`) are not mistaken for two projects. Falls back to the textual path when a side has no real path yet. */
function sameProjectDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return real(a) === real(b)
}

/**
 * `ctx` is typed structurally rather than as the full `ToolContext` so a
 * caller can pass either it or a `ToolContextBase` — the two carry the same
 * field, and this function needs nothing else from either.
 *
 * Throws `ProjectDirOutsideWorkspaceError` for a dir outside
 * `studio-workspace/`, and `ProjectDirMismatchError` for a bound connector
 * naming a different project than its turn's — see the module doc.
 */
export function resolveToolProjectDir(
  requested: string | null | undefined,
  ctx: { readonly workspaceDir?: string },
): string {
  if (!requested) return resolveProjectDir(ctx.workspaceDir)

  const resolved = resolveProjectDir(requested)
  if (ctx.workspaceDir) {
    const bound = resolveProjectDir(ctx.workspaceDir)
    if (!sameProjectDir(resolved, bound)) throw new ProjectDirMismatchError(resolved, bound)
  }
  return resolved
}
