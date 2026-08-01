/**
 * Tool registry root — Studio's one and only agent, two toolsets.
 *
 * Studio has exactly one agent (WS-12 §8.1 D3): there is no persisted scope
 * discriminator, no DB column, no per-conversation stored kind. What WS-12
 * §1 found is a real, separate gap from that decision — the CMS `site`
 * toolset (`site_insert_html`, `<studio-outlet>`, `data.rows`) cannot build
 * inside a real React repository, so a turn against an OPEN STUDIO PROJECT
 * needs the actual Studio tools (`./studio/`) instead. That choice is made
 * per-request from live context (`workspaceDir` on the chat body — the same
 * signal WS-11's `claudeCli` driver uses for its own `cwd`), never stored —
 * consistent with D3's reasoning, not a reintroduction of it.
 *
 * Capability filtering: `selectStudioTools` takes the caller's capability
 * set and filters through `toolAllowedForCapabilities` — write tools need
 * `ai.tools.write`, and any tool declaring `requiredCapabilities` (ANY-OF,
 * mirroring its HTTP-route equivalent) is only offered to callers holding
 * one. An `ai.chat`-only user (e.g. a Client persona granted chat) cannot
 * have the model issue a call the user couldn't make over HTTP — gated
 * tools are never registered with the driver in the first place.
 */

import type { CoreCapability } from '../../auth/capabilities'
import { toolAllowedForCapabilities } from './capabilityGate'
import type { AiTool } from './types'
import { siteTools } from './site'
import { studioAgentTools } from './studio'

/** The CMS site toolset — unchanged default when no Studio project is open. */
export const studioTools: AiTool[] = siteTools

export interface SelectStudioToolsContext {
  /** True when this turn is against an open Studio project (`workspaceDir` validated non-null). */
  readonly studioProjectOpen: boolean
}

/**
 * Returns the tools available for this turn, filtered against the caller's
 * capability set. The runtime hands this array to the driver verbatim;
 * drivers translate each `AiTool.inputSchema` (TypeBox) into the
 * provider-native tool format.
 *
 * `context.studioProjectOpen` (default `false`, so every existing single-arg
 * call site keeps returning the CMS toolset unchanged) picks the toolset:
 * the real Studio tools (`studioAgentTools`) when a project is open, the CMS
 * `site` tools otherwise.
 *
 * Filtering (see `toolAllowedForCapabilities`, the single gate):
 *   - a caller without `ai.tools.write` does not see tools tagged
 *     `mutates: true`;
 *   - a tool with `requiredCapabilities` (ANY-OF) is only offered to
 *     callers holding at least one of them — the agent inherits the
 *     caller's capabilities by construction instead of `ai.chat` acting
 *     as a blanket read grant.
 */
export function selectStudioTools(
  capabilities: readonly CoreCapability[],
  context: SelectStudioToolsContext = { studioProjectOpen: false },
): AiTool[] {
  const tools = context.studioProjectOpen ? studioAgentTools : studioTools
  return tools.filter((t) => toolAllowedForCapabilities(t, capabilities))
}
