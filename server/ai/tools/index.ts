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
import type { AiProviderId } from '../runtime/types'
import { toolAllowedForCapabilities } from './capabilityGate'
import type { AiTool } from './types'
import { siteTools } from './site'
import { studioAgentTools, studioHttpAgentTools, type AgentFileAccess } from './studio'
import { proposePlanTool } from '../mcp/tools/studio/proposePlanTool'

/** The CMS site toolset — unchanged default when no Studio project is open. */
export const studioTools: AiTool[] = siteTools

export interface SelectStudioToolsContext {
  /** True when this turn is against an open Studio project (`workspaceDir` validated non-null). */
  readonly studioProjectOpen: boolean
  /**
   * How this turn's driver touches files (P4-C, AI-2). `native` — the
   * `claude` CLI, which brings its own `Read`/`Write`/`Edit`/`Glob`/`Grep`.
   * `studio-tools` — every HTTP driver, which has none and gets Studio's file
   * tools instead. Only meaningful with a project open. Resolve it with
   * {@link agentFileAccessForProvider}; defaults to `native`.
   */
  readonly fileAccess?: AgentFileAccess
  /**
   * The composer's Plan mode (AI-22). On an HTTP driver it adds
   * `studio_propose_plan`, and the tool loop then refuses every write until a
   * plan is approved. The `claude` CLI has plan mode natively
   * (`--permission-mode plan` + `ExitPlanMode`), so it gets nothing extra.
   */
  readonly planMode?: boolean
}

/**
 * The file surface a provider's driver needs: only the `claude` CLI brings
 * its own file tools. Every other driver runs the shared HTTP tool loop, whose
 * only tools are the ones Studio hands it.
 */
export function agentFileAccessForProvider(providerId: AiProviderId): AgentFileAccess {
  return providerId === 'claudeCli' ? 'native' : 'studio-tools'
}

/**
 * Returns the tools available for this turn, filtered against the caller's
 * capability set. The runtime hands this array to the driver verbatim;
 * drivers translate each `AiTool.inputSchema` (TypeBox) into the
 * provider-native tool format.
 *
 * `context.studioProjectOpen` (default `false`) picks the toolset: the real
 * Studio tools when a project is open, the CMS `site` tools otherwise. With a
 * project open, `context.fileAccess` picks between `studioAgentTools` (the
 * CLI, native file tools) and `studioHttpAgentTools` (the HTTP drivers, which
 * also get Studio's file tools).
 *
 * Filtering (see `toolAllowedForCapabilities`, the single gate):
 *   - a caller without `ai.tools.write` does not see tools tagged
 *     `requiresWrite: true`;
 *   - a tool with `requiredCapabilities` (ANY-OF) is only offered to
 *     callers holding at least one of them — the agent inherits the
 *     caller's capabilities by construction instead of `ai.chat` acting
 *     as a blanket read grant.
 */
export function selectStudioTools(
  capabilities: readonly CoreCapability[],
  context: SelectStudioToolsContext = { studioProjectOpen: false },
): AiTool[] {
  const tools = !context.studioProjectOpen
    ? studioTools
    : context.fileAccess === 'studio-tools'
      ? [...studioHttpAgentTools, ...(context.planMode ? [proposePlanTool] : [])]
      : studioAgentTools
  return tools.filter((t) => toolAllowedForCapabilities(t, capabilities))
}
