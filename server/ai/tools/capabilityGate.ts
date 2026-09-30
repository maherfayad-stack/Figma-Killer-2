/**
 * Single chokepoint deciding whether a caller may use an AI tool.
 *
 * Two independent axes, both must pass:
 *   1. Write: a `requiresWrite` tool requires `ai.tools.write`. This reads
 *      `requiresWrite` and never `sideEffects` — what a call changes decides
 *      how the tool loop schedules it, not who may call it (AI-5).
 *   2. Capability: a tool's `requiredCapabilities` (ANY-OF) must be held by
 *      the caller. Undefined / empty means "any `ai.chat` caller" (e.g. tools
 *      that only read the browser-supplied snapshot).
 *
 * Used by `selectStudioTools` (which tools to offer the model) and
 * re-checked in `executeAiTool` (defence in depth before dispatch).
 */
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../runtime/types'

export function toolAllowedForCapabilities(
  tool: AiTool,
  capabilities: readonly CoreCapability[],
): boolean {
  if (tool.requiresWrite && !capabilities.includes('ai.tools.write')) return false
  const required = tool.requiredCapabilities
  if (required && required.length > 0) {
    if (!required.some((cap) => capabilities.includes(cap))) return false
  }
  return true
}
