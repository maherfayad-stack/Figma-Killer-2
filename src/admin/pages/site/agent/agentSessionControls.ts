/**
 * WS-12 §5.1 session controls state — `effort`/`permissionMode`, split out
 * of `agentSlice.ts` (which was pushing the module-size budget) since this
 * is a genuinely separable concern: two fields, two setters, no dependency
 * on anything else the slice owns.
 *
 * `agentPermissionMode`'s initial value, and the fact that nothing anywhere
 * reads it from storage, is the entire "Bypass never persists" mechanism at
 * store-init time; `AgentSessionControls.tsx` covers the other half (resetting
 * it on a live project switch, without a remount). What the invariant requires
 * is that the initial value is never `'bypassPermissions'` — not that it is
 * any one specific mode.
 */
import type { AiChatRequestBody, AiUserContentBlock } from '@core/ai'
import type { AgentSlice, EditorStoreSet } from './agentSliceTypes'

export type AgentSessionControlsState = Pick<AgentSlice, 'agentEffort' | 'agentPermissionMode'>
export type AgentSessionControlsActions = Pick<AgentSlice, 'setAgentEffort' | 'setAgentPermissionMode'>

export function agentSessionControlsInitialState(): AgentSessionControlsState {
  return {
    agentEffort: null,
    // 'acceptEdits' ("Auto") is the working default: Studio's entire purpose is
    // the agent editing the user's source, so prompting for permission on every
    // edit asks a question whose answer is always yes and turns a multi-edit
    // build into a click-through. 'default' ("Ask before edits") stays one
    // selection away for anyone who wants the per-edit gate back.
    //
    // This is NOT a relaxation of the Bypass guard rails. 'acceptEdits' only
    // waives the prompt for edits the agent was already capability-gated to
    // make (`studio.write`); it grants no tool it did not already have, and
    // trust tiers are enforced server-side with no permission-mode parameter to
    // read. WS-12 §5.2's "never persists" rule is about 'bypassPermissions'
    // specifically, and that is still never the initial value.
    agentPermissionMode: 'acceptEdits',
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
