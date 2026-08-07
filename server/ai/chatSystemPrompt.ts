/**
 * System-prompt resolution for `POST /admin/api/ai/chat` — split out of
 * `handlers/chat.ts` (module-size-budgets.test.ts's 700-line ceiling) as its
 * own responsibility: turning a turn's `snapshot` + open project (or lack of
 * one) into the string[] prompt `AiStreamRequest.systemPrompt` is built from.
 * The HTTP handler in `handlers/chat.ts` still CALLS both of these — this
 * file only owns how the answer is computed, not the request/response
 * lifecycle around it.
 *
 * Lives at `server/ai/` (a sibling of `contextTokens.ts`/`inputImages.ts`,
 * not inside `handlers/`) because `ai-handlers-capability-gated.test.ts`
 * requires every file directly under `server/ai/handlers/` to itself call
 * `requireCapability` — a real invariant for a route handler, but this module
 * never touches a `Request`; it runs AFTER `handlers/chat.ts`'s own gate has
 * already run, and gating it a second time would be theatre, not safety.
 */
import { safeParseValue } from '@core/utils/typeboxHelpers'
import {
  buildSiteSystemPrompt,
  SiteAgentSnapshotSchema,
  type SiteAgentSnapshot,
} from './tools/site'
import { buildStudioAgentSystemPrompt, studioPromptContextFromProfile } from './tools/studio'
import { buildStudioLiveDigest } from './tools/studio/liveDigest'
import { StudioAgentSnapshotSchema } from './tools/studio/snapshot'
import { resolveProjectProfile } from '../handlers/studio/projectProbe'
import { readStudioMeta } from '../handlers/studio/studioMeta'
import { projectDisplayName } from '../handlers/studioProjects'
import type { AiTool } from './tools/types'

/**
 * The CMS Site editor's prompt — used whenever no Studio project is open
 * (`validatedWorkspaceDir === null`). Named for what it builds, not for
 * "the Studio agent" (WS-12 §8.1 D3 collapsed that concept to "the one
 * agent"; it does not mean every prompt is the Studio-project one).
 */
export function buildCmsSiteSystemPrompt(snapshot: unknown): string[] {
  if (snapshot === undefined || snapshot === null) {
    return buildSiteSystemPrompt(emptySiteAgentSnapshot())
  }
  // The snapshot comes straight off the untyped HTTP body — validate it
  // before handing it to the prompt builder, and fall back to an empty
  // snapshot (rather than crashing the stream) when it's malformed.
  const result = safeParseValue(SiteAgentSnapshotSchema, snapshot)
  if (!result.ok) {
    console.error('[ai/chat] invalid site snapshot, using empty fallback:', result.errors)
    return buildSiteSystemPrompt(emptySiteAgentSnapshot())
  }
  return buildSiteSystemPrompt(result.value)
}

/**
 * The real Studio-project prompt (WS-12 §4). Project/profile/trust are
 * always built server-side from `dir` — the client never carries them (see
 * `studioAgentSnapshot.ts`'s own doc comment for why). `snapshot` is the
 * browser's lean `StudioAgentSnapshot` live-state (board/selection/axes ids);
 * when present and valid it drives `buildStudioLiveDigest` (WS-12 §2.1's
 * board/activePage/selection/fidelity/install lines, plus the §2.2 staleness
 * warning). Absent or malformed `snapshot` degrades to the profile-only
 * suffix — the static prefix's own tool-based instructions still work with
 * no live digest at all, so this is never a hard failure.
 *
 * Never throws: a profile-probe failure degrades to the "unavailable" suffix
 * rather than falling back to the CMS prompt, which would silently hand the
 * model the wrong tool vocabulary for an open Studio project.
 *
 * `tools` MUST be the SAME capability-filtered array (`selectStudioTools`)
 * this turn's `AiStreamRequest` is built with — passed straight through to
 * `buildStudioAgentSystemPrompt` so its "Tools available" line can never name
 * a tool this caller was not actually offered (STUDIO-FIGMA-PARITY-PLAN.md
 * 0.11). Do not resolve a second, unfiltered list here.
 */
export async function buildStudioProjectSystemPrompt(
  dir: string,
  snapshot: unknown,
  conversationId: string,
  tools: readonly AiTool[],
  /**
   * Test seam — defaults to the shared production staleness tracker
   * (`studioSnapshotStaleness`). Tests that exercise the §2.2 staleness rule
   * pass their OWN `createStalenessTracker()` instance so their assertions
   * never share state with another test file's run — the exact shape of
   * cross-test pollution `claudeCli.test.ts`'s roster tests hit once already.
   */
  liveDigestOptions?: Parameters<typeof buildStudioLiveDigest>[3],
): Promise<string[]> {
  let ctx: ReturnType<typeof studioPromptContextFromProfile>
  try {
    const trust = readStudioMeta(dir).trust ?? 'static'
    const profile = resolveProjectProfile(dir)
    const name = projectDisplayName(dir)
    ctx = studioPromptContextFromProfile(dir, name, trust, profile)
  } catch (err) {
    console.error('[ai/chat] failed to resolve the studio project profile, using the unavailable fallback:', err)
    return buildStudioAgentSystemPrompt(null, tools)
  }

  let live: Awaited<ReturnType<typeof buildStudioLiveDigest>> | null = null
  const parsedSnapshot = safeParseValue(StudioAgentSnapshotSchema, snapshot)
  if (parsedSnapshot.ok) {
    try {
      live = await buildStudioLiveDigest(dir, parsedSnapshot.value, conversationId, liveDigestOptions)
    } catch (err) {
      console.error('[ai/chat] failed to build the studio live digest, continuing without it:', err)
    }
  } else if (snapshot !== undefined && snapshot !== null) {
    console.error('[ai/chat] invalid studio snapshot, continuing without the live digest:', parsedSnapshot.errors)
  }

  return buildStudioAgentSystemPrompt(ctx, tools, live)
}

function emptySiteAgentSnapshot(): SiteAgentSnapshot {
  return {
    page: {
      id: '',
      title: 'Untitled',
      slug: '',
      rootNodeId: '',
      nodes: {},
    } as SiteAgentSnapshot['page'],
    currentDocument: { type: 'page', id: 'empty' },
    site: {
      pages: [],
      breakpoints: [],
      styleRules: {},
      visualComponents: [],
      settings: { shortcuts: {} },
    } as unknown as SiteAgentSnapshot['site'],
    selectedNodeId: null,
    activeBreakpointId: '',
  }
}
