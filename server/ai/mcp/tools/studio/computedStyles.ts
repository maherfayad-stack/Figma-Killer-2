/**
 * `studio_computed_styles` — the arithmetic half of the fidelity loop.
 *
 * Reports what a screen's CSS ACTUALLY resolved to, per node, so a design
 * difference is closed by comparing numbers rather than by guessing from a
 * picture. Two of those numbers are invisible in a screenshot by construction:
 * the font-weight a component variant resolved to, and — the one that cost four
 * correction rounds before this tool existed — the family the text is genuinely
 * SET IN, which differs from the declared stack exactly when a font failed to
 * load, and which no font-size edit can fix.
 *
 * ## W9-6: it stopped needing an editor tab
 *
 * This shipped as `execution: 'browser'`, relayed to the user's open Site
 * workspace, which meant ~8s of bridge timeout and then a refusal whenever no
 * tab was open — on a question whose entire subject matter is what is ON DISK.
 * The capture page renders exactly that (`headlessCapture.ts`'s doc explains
 * why doing so executes nothing of the user's), so the same read now runs
 * there by default.
 *
 * The live tab remains the FALLBACK, and remains the honest answer for the one
 * thing it alone holds: an unsaved in-progress edit. It is also what an install
 * with no Chromium degrades to, so this tool never becomes unavailable — it
 * just gets slower.
 *
 * **One implementation, two documents.** Headless and live both run
 * `@core/studio-capture`'s `inspectFrameDocument` against a frame iframe. If
 * the two paths had their own readers, the number this tool reports would
 * depend on which one answered, and a fidelity loop whose measurement moves is
 * not a measurement.
 */
import { StudioComputedStylesInputSchema, aiToolError } from '@core/ai'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { AgentComputedStylesResultSchema, type AgentFrameInspectRequest } from '@core/studio-capture'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { awaitEditorBridgeForUser } from '../../editorBridge'
import { inspectFrameHeadless } from '../../capture/headlessFrameInspect'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const computedStylesTool: AiTool = {
  name: 'studio_computed_styles',
  scope: 'shared',
  execution: 'server',
  description:
    'Read what a screen\'s CSS ACTUALLY resolved to: per node, the real font-size and line-height in px, the font-weight, the colour and background as rgb, and the font family the text is genuinely SET IN (not the declared stack — a stack whose first family never loaded looks identical to one that did, and that difference makes correct px look like the wrong size). Use it to close a design difference by arithmetic instead of guessing from a screenshot: compare these numbers against the design\'s own values (a Figma connector\'s variable-definitions tool gives exact tokens) and fix whatever disagrees. This is how you catch a component whose size/variant name resolves to a different token than you assumed, and a font-family naming a font the project never loaded — neither of which is visible in a picture, and the second of which no font-size edit can fix. Per NODE, so it covers buttons, inputs, labels and containers identically. Defaults to nodes with their own text (textOnly); pass textOnly:false for container padding/radius/background. It does NOT need a Studio browser tab open and never disturbs one that is — the screen is rendered in a headless browser on the server against what is on disk; the open tab is used only as a fallback when that browser cannot run. `readVia` in the result says which path answered.',
  inputSchema: StudioComputedStylesInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const args = input as {
      dir?: string
      pageId: string
      nodeIds?: string[]
      textOnly?: boolean
      limit?: number
    }
    const dir = resolveToolProjectDir(args.dir, ctx)
    const request: AgentFrameInspectRequest = {
      kind: 'computedStyles',
      pageId: args.pageId,
      ...(args.nodeIds === undefined ? {} : { nodeIds: args.nodeIds }),
      ...(args.textOnly === undefined ? {} : { textOnly: args.textOnly }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }

    const headless = await inspectFrameHeadless({ userId: ctx.userId, dir, request })
    if (headless.ok) {
      return { ok: true, data: { ...headless.result, dir, readVia: 'headless' } }
    }
    console.error(`[studio-computed-styles] headless read failed (${headless.code}): ${headless.error}`)

    // Fall back to the user's own tab — the only path left when there is no
    // Chromium, and the authoritative one for an unsaved in-progress edit.
    const bridge = await awaitEditorBridgeForUser(ctx.userId, 'site', ctx.signal)
    if (!bridge) {
      return aiToolError(
        // Names BOTH halves, the same rule `captureFrames.ts` follows: the old
        // single message sent a reader to open a tab that was already open when
        // the real cause was a browser that would not launch.
        `computed-styles-unavailable: neither path could read this screen. Headless render: ${headless.error} Live editor tab: no Studio board is connected (open the project in a Studio browser tab, or make the headless path work — it needs a Chromium available to playwright-core, installed with \`bunx playwright install chromium\`).`,
      )
    }
    const relayed = await bridge.callBrowser('studio_computed_styles', {
      pageId: args.pageId,
      ...(args.nodeIds === undefined ? {} : { nodeIds: args.nodeIds }),
      ...(args.textOnly === undefined ? {} : { textOnly: args.textOnly }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
    if (!relayed.ok) return relayed
    // The live half returns the SAME `AgentComputedStylesResult` the headless
    // half does — one reader, two documents — so this is a real validation,
    // not a cast past a boundary.
    const parsed = safeParseValue(AgentComputedStylesResultSchema, relayed.data)
    if (!parsed.ok) {
      const detail = parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
      return aiToolError(
        `The open Studio tab answered with a computed-styles result this server could not validate: ${detail}`,
      )
    }
    return {
      ok: true,
      data: { ...parsed.value, dir, readVia: 'live', headlessFallbackReason: headless.error },
    }
  },
}

export const studioComputedStylesMcpTools: AiTool[] = [computedStylesTool]
