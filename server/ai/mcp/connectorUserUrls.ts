/**
 * connectorUserUrls — the URLs the user pasted into the chat turn a
 * session-scoped MCP connector belongs to (P4-E, security review of #233 F8).
 *
 * `remoteFetchPolicy.ts` lets an agent make Studio fetch a URL the USER named,
 * and nothing else outside a short fixed list. On an HTTP driver the chat
 * handler hands those URLs to the tools directly
 * (`ToolContextBase.userSuppliedUrls`). The `claude` CLI path has no such
 * hand-off: its tool calls come back in through `/_studio/mcp`, where the only
 * identity is a connector id — the exact situation `connectorWorkspace.ts`
 * solves for the open project, solved the same way. An in-memory map keyed by
 * connector id, bound per turn by `bindConnectorRegistries`
 * (`claudeCliConnector.ts`) next to the workspace and the permission gate, and
 * released in the same `finally`.
 *
 * Rebound every turn, never accumulated: a warm session reuses its connector
 * across turns, and each turn's set is computed from the whole conversation
 * anyway.
 */

const urlsByConnectorId = new Map<string, readonly string[]>()

/** Bind this turn's user-supplied URLs to a connector. Returns the identity-checked release. */
export function registerConnectorUserUrls(connectorId: string, urls: readonly string[]): () => void {
  urlsByConnectorId.set(connectorId, urls)
  return () => {
    if (urlsByConnectorId.get(connectorId) === urls) urlsByConnectorId.delete(connectorId)
  }
}

/** The URLs bound to this connector's current turn, or `undefined` for a connector with no chat turn behind it. */
export function getConnectorUserUrls(connectorId: string): readonly string[] | undefined {
  return urlsByConnectorId.get(connectorId)
}
