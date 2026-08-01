/**
 * Site-editor agent-slice config — supplied to `createAgentSlice` when the
 * site editor's store is composed.
 *
 * Studio has exactly one agent, so this is the only `AgentSliceConfig` in
 * the app — but it now serves TWO different products through it (WS-12):
 *
 *   - a Studio project open (`useAdminUi`'s `studioProject` set) posts the
 *     lean live-state snapshot (`buildStudioAgentSnapshot`) — board/
 *     selection/axes only, never a node tree (Studio's truth is disk; the
 *     server re-derives everything else fresh every turn).
 *   - the CMS site editor (no Studio project open) posts the raw live page
 *     tree (active page + site) via `buildCurrentPageContext`, unchanged.
 *
 *   - dispatches write tools through the existing executor.ts (CMS `site_*`
 *     tools only — Studio's tools are `execution: 'server'` and need no
 *     browser bridge at all, see `runtime/types.ts`'s `ToolExecution` doc),
 *   - keeps the site-editor "no AI provider configured" copy so the panel can
 *     render its setup empty state.
 *
 * Lives in this folder (next to the site-editor agent code) so the site
 * editor's store has a stable import path; the snapshot logic doesn't escape
 * into the generic `createAgentSlice` factory.
 */

import type { AgentSliceConfig } from './agentSliceTypes'
import { buildCurrentPageContext } from './pageContext'
import { buildStudioAgentSnapshot } from './studioAgentSnapshot'
import { executeAgentTool } from './executor'
import { getAgentStoreApi } from './storeRef'
import type { EditorStore } from '@site/store/types'

export const siteAgentSliceConfig: AgentSliceConfig = {
  buildSnapshot: () => {
    const get = () => getAgentStoreApi<EditorStore>().getState()
    return buildStudioAgentSnapshot(get) ?? buildCurrentPageContext(get)
  },
  dispatchTool: executeAgentTool,
  // Keep the site-editor wording — the AgentPanel recognises this string
  // prefix and renders the setup CTA.
  noProviderMessage:
    'No AI provider configured for the site editor. Open /admin/ai/providers to add a credential, then /admin/ai/defaults to pick one.',
}
