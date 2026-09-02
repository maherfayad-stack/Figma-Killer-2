/**
 * Studio-scope snapshot type — re-exported server-side, same arrangement
 * `server/ai/tools/site/snapshot.ts` uses for `SiteAgentSnapshot`.
 *
 * `StudioAgentSnapshot` is the LEAN live-state object the browser posts each
 * turn when a Studio project is open (board/selection/axes only — see the
 * client module's own doc comment for why it does not carry
 * project/profile/fidelity/install, unlike WS-12 §2.1's original sketch).
 * Defined alongside its browser builder in `@site/agent/studioAgentSnapshot`;
 * re-exported here as the canonical server-side name so `chat.ts` and
 * `systemPrompt.ts` validate/consume it without reaching into `@site` directly.
 */

export { StudioAgentSnapshotSchema } from '@site/agent/studioAgentSnapshot'
export type { StudioAgentSnapshot } from '@site/agent/studioAgentSnapshot'
