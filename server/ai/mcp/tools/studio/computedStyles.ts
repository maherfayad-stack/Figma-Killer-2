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
 * This shipped as `execution: 'bridge'`, relayed to the user's open Site
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
import { StudioComputedStylesInputSchema, toolRefusal } from '@core/ai'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { AgentComputedStylesResultSchema, type AgentFrameInspectRequest } from '@core/studio-capture'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { awaitEditorBridgeForUser, editorBridgeScope } from '../../editorBridge'
import { inspectFrameHeadless } from '../../capture/headlessFrameInspect'
import { resolveToolProjectDir } from './resolveToolProjectDir'

const computedStylesTool: AiTool = {
  name: 'studio_computed_styles',
  scope: 'shared',
  execution: 'server-with-bridge-fallback',
  sideEffects: 'none',
  description:
    'What a screen\'s CSS actually resolved to, per node: font-size and line-height in px, font-weight, colour and background as rgb, and the font family the text is really set in (a stack whose first family never loaded looks the same in a picture). Compare these numbers with the design\'s own values and fix what disagrees: it catches a variant that resolves to a different token and a font the project never loads, neither of which a screenshot shows. textOnly (the default) covers nodes with their own text; textOnly:false adds containers (padding, radius, background). Renders headless on the server from what is on disk; an open tab is used only as a fallback (readVia says which).',
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
    const bridge = await awaitEditorBridgeForUser(ctx.userId, editorBridgeScope(dir), ctx.signal)
    if (!bridge) {
      // Names BOTH halves, the same rule `captureFrames.ts` follows: the old
      // single message sent a reader to open a tab that was already open when
      // the real cause was a browser that would not launch.
      return toolRefusal(
        'measure-unavailable',
        `Neither path could read this screen. Headless render: ${headless.error} Live editor tab: no Studio board is connected.`,
        {
          remedy: 'Make the headless path work — it needs a Chromium available to playwright-core, installed with `bunx playwright install chromium` — or ask the user to open the project in a Studio browser tab. Report it rather than calling again unchanged.',
          details: { headlessCode: headless.code },
        },
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
      return toolRefusal(
        'measure-unavailable',
        `The open Studio tab answered with a computed-styles result this server could not validate: ${detail}`,
        { remedy: 'The tab is running a different build than this server. Ask the user to reload it.' },
      )
    }
    return {
      ok: true,
      data: { ...parsed.value, dir, readVia: 'live', headlessFallbackReason: headless.error },
    }
  },
}

export const studioComputedStylesMcpTools: AiTool[] = [computedStylesTool]
