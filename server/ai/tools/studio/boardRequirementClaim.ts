/**
 * The "a disconnected board is not a dead end" paragraph of the Studio system
 * prompt, GENERATED from each offered tool's `execution` metadata rather than
 * written by hand.
 *
 * ## Why it is generated
 *
 * It used to be prose naming `studio_computed_styles` and
 * `studio_page_diagnostics` as the tools that need the open board. That was
 * true when it was written and stopped being true in `mcp-20`, when
 * `studio_computed_styles` went headless — and nothing failed, because a
 * prompt sentence has no compiler. The agent was told for months that a
 * working tool required a tab, which is the most expensive kind of wrong: it
 * produces no error, it produces a tool that never gets called.
 *
 * Both lists now come from the same `execution` field the RUNNER dispatches on
 * (`../../runtime/toolExecution.ts`), off the caller's own capability-filtered
 * `tools` array — so the prompt cannot name a tool this caller was not
 * offered, and cannot describe any tool's board requirement wrongly without
 * the dispatch being wrong in the same way.
 * `prompt-claims-match-tool-metadata.test.ts` is the gate.
 *
 * ## Why it is its own module
 *
 * `systemPrompt.ts` is a shared, actively-contended file that has already been
 * pushed past the 700-line module ceiling once (A9/A12/A13 moved `MODE_BLOCK`
 * and `DESIGN_POLICY_BLOCK` to `promptSessionBlocks.ts` for the same reason).
 * A generated section with a doc comment this long belongs beside it, not in
 * it.
 */
import {
  formatToolNameList,
  toolsRequiringOpenBoard,
  toolsWithBridgeFallback,
} from '../../runtime/toolExecution'
import type { AiTool } from '../types'

export function buildBoardRequirementParagraph(tools: readonly AiTool[]): string {
  const headless = formatToolNameList(toolsWithBridgeFallback(tools))
  const boardOnly = toolsRequiringOpenBoard(tools)

  const headlessHalf = `TREATING A DISCONNECTED BOARD AS A DEAD END. ${headless} do NOT need the user's tab: they render the pages off disk in a server-side headless browser first, and only fall back to relaying to an open board when that cannot run. A result carrying capturedVia:"headless" (or readVia:"headless") never involved a tab at all. If one of them fails, read WHICH half failed — "capture-unavailable" names both, and a headless failure is usually a missing Chromium (bunx playwright install chromium), which is a thing to report, not a board problem.`

  if (boardOnly.length === 0) {
    return `${headlessHalf} Nothing you have been offered this turn requires the open board at all, so "no board is connected" is never the reason a call of yours failed.`
  }

  return `${headlessHalf} The only tools that genuinely require the open board are ${formatToolNameList(boardOnly)} — every other tool you have works with no tab at all. Those that read the live frames wait for a reconnecting tab internally before answering (one reconnect window when a board was live moments ago, two when nothing is known to be reconnecting), so a refusal naming a disconnected board is a settled fact, not a race: the project is genuinely not open. Say so in one sentence, and do not write a pile of files you have no way to verify.`
}
