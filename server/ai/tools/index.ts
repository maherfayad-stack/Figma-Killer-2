/**
 * Tool registry root — Studio's one and only toolset.
 *
 * Studio has exactly one agent (WS-12 §8.1 D3): there is no scope
 * discriminator here anymore, just the full set of tools the Studio agent
 * can call, filtered per-caller by capability.
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

/** The full Studio toolset — the same 35 tools regardless of caller. */
export const studioTools: AiTool[] = siteTools

/**
 * Returns the tools available to the Studio agent, filtered against the
 * caller's capability set. The runtime hands this array to the driver
 * verbatim; drivers translate each `AiTool.inputSchema` (TypeBox) into
 * the provider-native tool format.
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
): AiTool[] {
  return studioTools.filter((t) => toolAllowedForCapabilities(t, capabilities))
}
