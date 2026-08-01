/**
 * WS-12 §5.1 session controls state — `effort`/`permissionMode`, split out
 * of `agentSlice.ts` (which was pushing the module-size budget) since this
 * is a genuinely separable concern: two fields, two setters, no dependency
 * on anything else the slice owns.
 *
 * `agentPermissionMode`'s default (`'default'`) and the fact that nothing
 * anywhere reads it from storage is the entire "Bypass never persists"
 * mechanism at store-init time; `AgentSessionControls.tsx` covers the other
 * half (resetting it on a live project switch, without a remount).
 */
import type { AiChatRequestBody, AiUserContentBlock } from '@core/ai'
import type { AgentSlice, EditorStoreSet } from './agentSliceTypes'

export type AgentSessionControlsState = Pick<AgentSlice, 'agentEffort' | 'agentPermissionMode'>
export type AgentSessionControlsActions = Pick<AgentSlice, 'setAgentEffort' | 'setAgentPermissionMode'>

export function agentSessionControlsInitialState(): AgentSessionControlsState {
  return {
    agentEffort: null,
    // Always 'default' at store creation — WS-12 §5.2's "never persists"
    // rule for Bypass applies here, at the one place this value is ever
    // initialized from anything other than a live user selection.
    agentPermissionMode: 'default',
  }
}

export function createAgentSessionControlsActions(set: EditorStoreSet): AgentSessionControlsActions {
  return {
    setAgentEffort(effort) {
      set({ agentEffort: effort })
    },
    setAgentPermissionMode(mode) {
      set({ agentPermissionMode: mode })
    },
  }
}

/**
 * Assembles the `/admin/api/ai/chat` request body — the CMS `snapshot`,
 * the open Studio project's dir (only `claudeCli` reads it server-side;
 * every other driver ignores it), and this file's own session-control
 * fields. `workspaceDir` comes from `useAdminUi` (not the site editor's own
 * store) — the one place that already tracks "which project is open".
 */
export function buildChatRequestBody(params: {
  conversationId: string
  content: readonly AiUserContentBlock[]
  snapshot: unknown
  workspaceDir: string | undefined
  agentEffort: AgentSlice['agentEffort']
  agentPermissionMode: AgentSlice['agentPermissionMode']
}): AiChatRequestBody {
  const { conversationId, content, snapshot, workspaceDir, agentEffort, agentPermissionMode } = params
  return {
    conversationId,
    content: [...content],
    snapshot,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(agentEffort ? { effort: agentEffort } : {}),
    ...(agentPermissionMode ? { permissionMode: agentPermissionMode } : {}),
  }
}
