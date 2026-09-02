/**
 * connectorWorkspace — which Studio project a session-scoped MCP connector's
 * tool calls belong to.
 *
 * ## The bug this exists to fix
 *
 * Every Studio tool takes an optional `dir`, and `resolveProjectDir(undefined)`
 * falls back to `listStudioProjects(root)[0]` — the FIRST project in
 * alphabetical order. That default predates there being more than one project.
 * Once a user had two, an agent that omitted `dir` (which it does by default,
 * because the parameter is documented as optional) silently read and wrote
 * `untitled` while the human was looking at `untitled-2`.
 *
 * Nothing surfaced the mismatch: the tools succeeded, returned real data, and
 * described a project the user could not see. It reads exactly like the agent
 * "remembering" the wrong workspace — the observable symptom that led here —
 * when in fact each turn was being silently redirected by a default.
 *
 * ## Why a registry rather than a tool parameter or a DB column
 *
 * The chat path knows the open project: `chat.ts` validates `workspaceDir`
 * once per turn. But the Studio agent does NOT call tools through that path —
 * it is a `claude` subprocess that reaches back through `/_studio/mcp`
 * (`sessionConnector.ts`), so by the time a tool runs, the only identity in
 * hand is a connector id.
 *
 * That makes this the same shape as `permissionGate.ts`, and it is
 * deliberately solved the same way: an in-memory map keyed by connector id,
 * registered next to the gate before the CLI spawns and released in the same
 * `finally` that revokes the connector. A session connector is per-turn and
 * in-process, so persisting its workspace would mean an additive migration for
 * state that must not outlive the turn anyway.
 *
 * A `dir` the caller passes EXPLICITLY always wins — this only replaces the
 * "caller said nothing" default, turning "first project alphabetically" into
 * "the project this turn is actually about".
 */

const workspaceByConnectorId = new Map<string, string>()

/**
 * Bind a connector to the Studio project its turn is operating on. Returns the
 * release function; call it when the turn ends.
 *
 * The release is identity-checked (same posture as `registerPermissionGate`):
 * it only clears the entry when it is still the one this call installed, so a
 * late release from a finished turn cannot unbind a newer turn that has since
 * reused the id.
 */
export function registerConnectorWorkspace(connectorId: string, workspaceDir: string): () => void {
  workspaceByConnectorId.set(connectorId, workspaceDir)
  return () => {
    if (workspaceByConnectorId.get(connectorId) === workspaceDir) workspaceByConnectorId.delete(connectorId)
  }
}

/** The project bound to this connector, or `undefined` when the turn carried no open workspace. */
export function getConnectorWorkspace(connectorId: string): string | undefined {
  return workspaceByConnectorId.get(connectorId)
}
