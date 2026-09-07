/**
 * `studio_computed_styles` — the LIVE-TAB half.
 *
 * Since W9-6 this is the fallback, not the default: the server answers the same
 * question headlessly against what is on disk (`headlessFrameInspect.ts`), and
 * relays here only when the headless browser cannot run, or when the caller
 * genuinely wants what only this tab holds — an in-progress edit that has not
 * been saved yet.
 *
 * What is left in this file is exactly the part that is about THIS tab: finding
 * the board frame, reaching its iframe document, and turning "there is no such
 * frame" into a sentence a reader can act on. The measurement itself is
 * `@core/studio-capture`'s `inspectFrameDocument`, the identical function the
 * headless capture page runs — one reader over two documents, so the number
 * this tool reports cannot depend on which path answered.
 *
 * ## Where it reads
 *
 * The iframe's document, never the frame host element. Every board frame
 * renders its page inside its own `<iframe>` (`IframeFrameSurface`), so both
 * the nodes and the window that resolves style for them belong to that iframe.
 * Reading the host finds no page nodes at all — and would resolve font
 * availability against the ADMIN document, which knows nothing about the fonts
 * the user's project loaded.
 */
import { parseValue } from '@core/utils/typeboxHelpers'
import { StudioComputedStylesInputSchema, aiToolError, aiToolOk } from '@core/ai'
import type { AiToolOutput } from '@core/ai'
import { inspectFrameDocument } from '@core/studio-capture'
import { findAgentRenderFrame } from './renderEvidence'

const STUDIO_BREAKPOINT_ID = 'studio'

export function runStudioComputedStyles(rawInput: unknown): AiToolOutput {
  const input = parseValue(StudioComputedStylesInputSchema, rawInput)

  const frame = findAgentRenderFrame({ breakpointId: STUDIO_BREAKPOINT_ID, pageId: input.pageId })
  if (!frame) {
    return aiToolError(
      `No live frame for page "${input.pageId}". This is the LIVE-TAB read, so the project must be open in a Studio tab and the page must have a board frame (studio_screenshot places one).`,
    )
  }

  const iframe = frame.querySelector<HTMLIFrameElement>('iframe')
  const doc = iframe?.contentDocument ?? null
  const view = doc?.defaultView ?? null
  if (!doc?.body || !view) {
    return aiToolError(
      `The board frame for page "${input.pageId}" has not finished mounting its document yet, so there is nothing to measure — this is NOT an empty page. Take a studio_screenshot to force the frame to settle, then call this again.`,
    )
  }

  const response = inspectFrameDocument(doc, view, {
    kind: 'computedStyles',
    pageId: input.pageId,
    ...(input.nodeIds === undefined ? {} : { nodeIds: input.nodeIds }),
    ...(input.textOnly === undefined ? {} : { textOnly: input.textOnly }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })
  return response.ok ? aiToolOk(response.result) : aiToolError(response.error)
}
