/**
 * WS-12 §5.1 session controls state — `effort`/`permissionMode`, split out
 * of `agentSlice.ts` (which was pushing the module-size budget) since this
 * is a genuinely separable concern: two fields, two setters, no dependency
 * on anything else the slice owns.
 *
 * `agentPermissionMode`'s initial value is now `'bypassPermissions'` — a
 * deliberate product decision, and a real change to what WS-12 §5.2 called
 * "Bypass never persists". Read {@link agentSessionControlsInitialState} for
 * the reasoning and for what that rule protected that this does NOT give up.
 */
import type { AiChatRequestBody, AiUserContentBlock } from '@core/ai'
import type { AgentSlice, EditorStoreSet } from './agentSliceTypes'

export type AgentSessionControlsState = Pick<AgentSlice, 'agentEffort' | 'agentPermissionMode'>
export type AgentSessionControlsActions = Pick<AgentSlice, 'setAgentEffort' | 'setAgentPermissionMode'>

export function agentSessionControlsInitialState(): AgentSessionControlsState {
  return {
    agentEffort: null,
    // Bypass is the working default. Studio's entire purpose is the agent
    // editing the user's source; every prompt on that path asks a question
    // whose answer is always yes, and 'acceptEdits' only silenced the FILE-edit
    // half — every MCP tool call still raised an Allow/Deny card mid-build.
    // 'default' ("Ask before edits") and 'plan' stay one selection away.
    //
    // WHAT THIS DOES AND DOES NOT WIDEN, because the distinction is the whole
    // reason this is defensible. Permission mode affects PROMPTING for an
    // already-available tool. It never widens which tools exist: `--tools`
    // (`claudeCliToolSurface.ts`) is a hard availability list the CLI evaluates
    // independently of and PRIOR to `--permission-mode`, `Bash` and `Task` are
    // withheld unconditionally at every mode, and a native write is bounded by
    // the subprocess `cwd` (the containment-checked project directory), not by
    // the permission mode. Studio's own tools stay gated by the minted
    // connector's capabilities, floored to the caller's; `studio_install_deps`
    // reads `.studio/meta.json`'s trust tier and has no permission-mode
    // parameter to read. So this removes questions, not boundaries.
    //
    // THE COST, stated rather than buried: nothing reads this from storage, so
    // a user who deliberately switches to a SAFER mode is back in Bypass after
    // a reload. Under the old default that reset direction was always toward
    // safety; now it is away from it. Making an explicit downgrade stick would
    // mean persisting the mode, which this design deliberately does not do —
    // if that trade stops being acceptable, persist the user's explicit choice
    // rather than moving this value back and forth.
    agentPermissionMode: 'bypassPermissions',
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
