/**
 * "Changed N files" under each agent turn, the per-file diff, and the user's
 * revert (AI-7) — the client half of `server/ai/handlers/agentCheckpoints.ts`.
 *
 * The server keeps a checkpoint per turn (`.studio/agent-checkpoints/`): what
 * each file held before the turn and what the agent left. This module fetches
 * that list into `agentTurnChanges` (keyed by turn id — the persisted id of
 * the user message that opened the turn), and asks for a revert. A revert is
 * compare-and-swap on the server: a file somebody changed after the agent is
 * refused by name, never overwritten, and that refusal is returned as data for
 * the card to show — it is an honest answer, not a failure to toast.
 */
import { ApiError, apiRequest, isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { agentProjectDir } from './agentProjectDir'
import type { AgentSlice, AgentSliceGet, EditorStoreSet } from './agentSliceTypes'
import {
  DiffResponseSchema,
  ListResponseSchema,
  RevertResponseSchema,
  type AgentTurnFileDiff,
} from './agentTurnChangeTypes'

const BASE = '/admin/api/ai/agent-checkpoints'

export async function fetchAgentTurnFileDiff(conversationId: string, turnId: string, path: string, signal?: AbortSignal): Promise<AgentTurnFileDiff> {
  const dir = agentProjectDir()
  if (!dir) throw new Error('No Studio project is open.')
  return apiRequest(`${BASE}/diff`, { query: { dir, conversationId, turnId, path }, schema: DiffResponseSchema, signal })
}

export function agentTurnChangesInitialState(): Pick<AgentSlice, 'agentTurnChanges'> {
  return { agentTurnChanges: {} }
}

/** Monotonic, so a slow list that lands after a newer one (or after a conversation switch) is dropped. */
let listEpoch = 0

export function createAgentTurnChangesActions(
  set: EditorStoreSet,
  get: AgentSliceGet,
): Pick<AgentSlice, 'refreshAgentTurnChanges' | 'revertAgentTurn'> {
  return {
    async refreshAgentTurnChanges() {
      const epoch = ++listEpoch
      const conversationId = get().agentConversationId
      const dir = agentProjectDir()
      if (!conversationId || !dir) {
        set({ agentTurnChanges: {} })
        return
      }
      try {
        const { turns } = await apiRequest(BASE, { query: { dir, conversationId }, schema: ListResponseSchema })
        if (epoch !== listEpoch || get().agentConversationId !== conversationId) return
        set({ agentTurnChanges: Object.fromEntries(turns.map((turn) => [turn.turnId, turn])) })
      } catch (err) {
        // A read nobody clicked for: no toast. The cards simply do not appear,
        // and the next turn's refresh tries again.
        if (isAbortError(err)) return
        console.error('[AgentSlice] Failed to load what the agent changed:', err)
      }
    },

    async revertAgentTurn(turnId, paths) {
      const conversationId = get().agentConversationId
      const dir = agentProjectDir()
      if (!conversationId || !dir) return { ok: false, message: 'No Studio project is open.' }
      try {
        const { reverted } = await apiRequest(`${BASE}/revert`, {
          method: 'POST',
          body: paths ? { dir, conversationId, turnId, paths } : { dir, conversationId, turnId },
          schema: RevertResponseSchema,
        })
        return { ok: true, reverted }
      } catch (err) {
        // A refusal (409: changed since, already reverted) carries its reason;
        // the card shows it where the button was.
        if (!(err instanceof ApiError)) console.error('[AgentSlice] Revert failed:', err)
        return { ok: false, message: getErrorMessage(err, 'The revert did not go through.') }
      } finally {
        await get().refreshAgentTurnChanges()
      }
    },
  }
}
