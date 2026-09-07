/**
 * `studio_page_diagnostics` — what the screen's RUNTIME said, as opposed to
 * what its picture looks like.
 *
 * ## The gap
 *
 * A frame whose component throws renders as a blank rectangle. `studio_screenshot`
 * returns that rectangle, honestly and with no error, and every downstream tool
 * agrees with it: `studio_compare` reports ~100% different, `studio_quality_check`
 * finds nothing wrong with a stylesheet that never ran, `studio_computed_styles`
 * reports the computed style of an empty body. So the loop that follows a blank
 * frame is: screenshot, adjust CSS, screenshot, adjust CSS — against a page that
 * never executed. The one fact that ends it in a single step ("TypeError: cannot
 * read properties of undefined (reading 'map') at Checkout.tsx:42") existed the
 * whole time, in the frame's own console, unread.
 *
 * This tool is the read of that console, plus the four other failure channels a
 * console tail alone would miss: unhandled rejections, failed asset loads,
 * failed module resolutions, and failed `fetch`es from inside the frame.
 *
 * ## Shape
 *
 * `execution: 'server'` and relayed, the same arrangement `studio_screenshot`
 * uses and for the same reason: the SERVER half resolves screen NAMES to page
 * ids (the agent knows it wrote `Checkout.tsx`, not that Studio calls it
 * `checkout`) and owns the "no board is connected" message, while the actual
 * read happens in the browser (`src/admin/pages/site/agent/studioPageDiagnostics.ts`)
 * because that is where the frames are. Batch by construction — one call covers
 * every screen the turn just wrote.
 *
 * It is a pure READ: no `mutates`, no `requiredCapabilities`, same posture as
 * every other Studio read tool. It deliberately does NOT sync board frames from
 * disk the way `studio_screenshot` does — placing a frame would be a mutation,
 * and a page with no frame is a genuinely different answer this tool reports
 * rather than papers over.
 *
 * ## Finding codes
 *
 * Every finding carries a stable `code` from `@core/ai`'s
 * `PAGE_DIAGNOSTIC_CODES` plus that code's `fix` — a suggested next action, not
 * just a symptom. The vocabulary is documented in
 * `docs/features/mcp-connectors.md` and gated for parity by
 * `pageDiagnostics.test.ts`.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { PAGE_DIAGNOSTIC_CODES, type PageDiagnosticCode } from '@core/ai'
import { decodeSourceNodeId } from '@core/page-tree'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { awaitEditorBridgeForUser, editorBridgeScope } from '../../editorBridge'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { MAX_BATCH_PAGES, resolveRequestedPages } from './pageNameMatch'

const PageDiagnosticsInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    pages: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_BATCH_PAGES,
        description:
          'Which screens to read, by name — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work. Omit to read every screen in the project (up to 20).',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Cap on distinct findings reported PER SCREEN. Default 25; anything beyond it is reported as a count, never dropped silently.',
      }),
    ),
  },
  { additionalProperties: false },
)

/** The browser leg's per-page shape, as this tool consumes it back off the bridge. */
interface BrowserPageResult {
  pageId?: unknown
  status?: unknown
  findings?: unknown
}

interface RawFinding {
  code?: unknown
  nodeId?: unknown
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Attach the code's documented `fix`, and — when the failure happened on a real
 * element — the `file:line:col` its node id decodes to.
 *
 * A visual/runtime finding is only actionable with a source location, and a
 * Studio node id already IS one (`src/core/page-tree/sourceNodeId.ts`). Decoding
 * it here means the agent does not need a second `studio_get_node_source` round
 * trip to act on an asset that 404'd.
 */
function enrichFinding(finding: RawFinding): Record<string, unknown> {
  const code = typeof finding.code === 'string' ? (finding.code as PageDiagnosticCode) : null
  const def = code ? PAGE_DIAGNOSTIC_CODES[code] : undefined
  const nodeId = typeof finding.nodeId === 'string' ? finding.nodeId : null
  const loc = nodeId ? decodeSourceNodeId(nodeId) : null
  return {
    ...finding,
    ...(def ? { title: def.title, severity: def.severity, fix: def.fix } : {}),
    ...(loc ? { source: { file: loc.rel, line: loc.line, col: loc.col } } : {}),
  }
}

export const studioPageDiagnosticsTool: AiTool = {
  name: 'studio_page_diagnostics',
  scope: 'shared',
  execution: 'server',
  description:
    'Read what a screen\'s RUNTIME reported since it loaded: uncaught exceptions, unhandled promise rejections, console.error output (this is how React reports a failed render, an invalid hook call and a hydration mismatch), assets that failed to load, module specifiers that did not resolve, and fetches that failed. Call this the moment a screenshot looks blank, half-empty, or unchanged after a write — a frame whose component threw photographs as an empty rectangle, and no amount of CSS editing fixes a page that never executed. Batch: name several screens in one call. Each finding carries a stable code, a count of how many times it happened, a suggested fix, and — for a failure on a real element — the file:line its node id decodes to. A screen with NO live board frame is reported as such (status "no-frame"), never as clean.',
  inputSchema: PageDiagnosticsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pages: requested, limit } = input as {
      dir?: string
      pages?: string[]
      limit?: number
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const bridge = await awaitEditorBridgeForUser(ctx.userId, editorBridgeScope(dir), ctx.signal)
    if (!bridge) {
      return {
        ok: false,
        error: 'No Studio board is connected. Runtime diagnostics are collected inside the live canvas frames, so this needs the project open in a Studio browser tab. If it IS open, the tab reconnects on its own within a few seconds — just call this again once.',
      }
    }

    const { pages } = await loadStudioPages(dir)
    const { ids, unmatched } = resolveRequestedPages(pages, requested, MAX_BATCH_PAGES)
    if (ids.length === 0) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return {
        ok: false,
        error: unmatched.length > 0
          ? `No screen matched ${unmatched.map((n) => `"${n}"`).join(', ')}. This project has: ${known}.`
          : 'This project has no screens to read diagnostics for yet.',
      }
    }

    const relayed = await bridge.callBrowser('studio_page_diagnostics', {
      pageIds: ids,
      ...(limit === undefined ? {} : { limit }),
    })
    if (!relayed.ok) return relayed

    const data = isRecord(relayed.data) ? relayed.data : {}
    const rawPages = Array.isArray(data.pages) ? (data.pages as BrowserPageResult[]) : []
    const enrichedPages = rawPages.map((page) => {
      const findings = Array.isArray(page.findings)
        ? (page.findings as RawFinding[]).map(enrichFinding)
        : undefined
      return { ...page, ...(findings ? { findings } : {}) }
    })

    // A single number the caller can branch on without walking the array —
    // "did anything break" is the question this tool is usually asked.
    const errorCount = enrichedPages.reduce(
      (total, page) =>
        total +
        (Array.isArray(page.findings)
          ? page.findings.filter((f) => (f as { severity?: unknown }).severity === 'error').length
          : 0),
      0,
    )

    return {
      ok: true,
      data: {
        dir,
        pages: enrichedPages,
        errorCount,
        ...(unmatched.length > 0 ? { unmatched } : {}),
      },
    }
  },
}

export const studioPageDiagnosticsMcpTools: AiTool[] = [studioPageDiagnosticsTool]
