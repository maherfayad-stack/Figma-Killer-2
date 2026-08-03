/**
 * `StudioAgentDef` — the one shared shape every generated `.claude/agents/
 * *.md` roster entry is built from. Split out of `agentRoster.ts` into its
 * own leaf so `agentRosterMcpTools.ts` and `agentRosterFigma.ts` can both
 * depend on the TYPE without either of them importing `agentRoster.ts`
 * itself (which imports THEM for the values it composes into the roster) —
 * a plain type-only leaf, never a runtime cycle.
 */
export interface StudioAgentDef {
  /** File stem — `.claude/agents/<name>.md`. Also the CLI's own agent `name`. */
  readonly name: string
  /** One line — when the main agent should delegate to this one. */
  readonly description: string
  /**
   * Explicit tool allowlist. Every native name must exist in
   * `studioAgentTools`; an `mcp__<server>__<tool>` name must name a server
   * this project has actually approved — see `agentRosterMcpTools.ts`'s
   * `assertKnownAgentTools`, the single gate both sources go through. Empty
   * (`[]`) is a deliberate choice for a text-only agent, not an oversight.
   */
  readonly tools: readonly string[]
  readonly prompt: string
}
