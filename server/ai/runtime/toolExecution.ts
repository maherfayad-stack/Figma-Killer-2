/**
 * `ToolExecution` — the one declaration of where a tool's work happens, and
 * the two predicates everything else derives from it.
 *
 * ## Why this is a three-value enum and not a boolean
 *
 * It used to be `'server' | 'browser'`, which conflated two different
 * questions that had already drifted apart in practice:
 *
 *   1. **Does the RUNNER dispatch this in-process, or relay the whole call?**
 *   2. **Does this tool NEED the connector owner's board to be open?**
 *
 * W9-6 moved `studio_computed_styles`, `studio_screenshot`, `studio_compare`
 * and `studio_export_frames` to a headless-first path that falls back to an
 * open tab only when Chromium cannot run. They answer "no" to (2) and were
 * still filed next to tools that answer "yes". The system prompt read that
 * metadata, and told the agent for months that `studio_computed_styles`
 * required the open board — a claim that had been false since `mcp-20`. A
 * prompt that describes a tool wrongly is worse than one that omits it: the
 * agent stops calling a tool that works.
 *
 * Meanwhile `studio_page_diagnostics` is the mirror-image case — dispatched
 * in-process, but its handler relays to the board and genuinely cannot answer
 * without one, because it reads the live frames' consoles.
 *
 * So:
 *
 * | value | dispatch | needs the open board |
 * |---|---|---|
 * | `server` | in-process | never |
 * | `server-with-bridge-fallback` | in-process | never — the board is a fallback, not a requirement |
 * | `bridge` | in-process when the tool declares its own `handler` (which owns the relay and the refusal message), relayed by the runner otherwise | yes |
 *
 * Both columns are read through the predicates below rather than by
 * re-matching the literal at each site, so a new value cannot half-land.
 */
import type { AiTool } from './types'

/**
 * Does the runner invoke `handler(input, ctx)` in-process?
 *
 * True for everything except a `bridge` tool with NO handler — the sentinel
 * shape (`site/writeTools.ts`, `uploadAssetTool.ts`) that declares only
 * name/description/schema/gate because its whole implementation lives
 * client-side. A `bridge` tool that DOES declare a handler
 * (`pageDiagnostics.ts`) relays from inside that handler, which is also where
 * it owns the "no board is connected" message.
 */
export function toolDispatchesInProcess(tool: AiTool): boolean {
  return tool.execution !== 'bridge' || tool.handler !== undefined
}

/**
 * Does this tool fail outright when the connector owner has no Studio
 * workspace open?
 *
 * This is the question the system prompt's live-tab sentence is generated
 * from (`tools/studio/systemPrompt.ts`) and the one an agent actually needs
 * answered. A headless-first tool with a bridge fallback answers `false`: it
 * gets slower without a board, never unavailable.
 */
export function toolRequiresOpenBoard(tool: AiTool): boolean {
  return tool.execution === 'bridge'
}

/** The `bridge`-only names in `tools`, sorted — the exact set the prompt may claim needs the open board. */
export function toolsRequiringOpenBoard(tools: readonly AiTool[]): string[] {
  return tools.filter(toolRequiresOpenBoard).map((t) => t.name).sort()
}

/**
 * The headless-first names in `tools`, sorted — the exact set the prompt may
 * claim works with no tab open. The complement of the list above within the
 * tools that touch a frame at all.
 */
export function toolsWithBridgeFallback(tools: readonly AiTool[]): string[] {
  return tools
    .filter((t) => t.execution === 'server-with-bridge-fallback')
    .map((t) => t.name)
    .sort()
}

/** `a`, `b` and `c` — for rendering a generated tool list into prose. */
export function formatToolNameList(names: readonly string[]): string {
  if (names.length === 0) return 'none'
  if (names.length === 1) return names[0]!
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`
}
