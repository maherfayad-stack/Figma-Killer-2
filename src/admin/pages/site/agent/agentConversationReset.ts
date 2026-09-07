/**
 * agentConversationReset — the two conversation-lifecycle helpers that are
 * about STATE SHAPE rather than about the slice's send/stream loop.
 *
 * Extracted from `agentSlice.ts` when that file reached the 700-line module
 * ceiling: both are pure functions over the slice's own fields, neither
 * touches the network or the stream, and three separate actions
 * (`clearAgentMessages`, `startNewAgentConversation`, `deleteAgentConversation`)
 * reach for the reset one.
 */
import type { AgentSlice, EditorStoreSet } from './agentSliceTypes'
import type { AgentConversationUsage } from './agentSliceTypes'
import { failPendingToolCalls } from './toolCallLifecycle'

// The canonical conversation-reset key-set, in ONE place. clearAgentMessages,
// startNewAgentConversation, and deleteAgentConversation all reset through here
// so they can't drift apart again (usage was omitted from one copy once;
// agentError from another). A factory (not a shared constant) so
// each reset gets a fresh `agentMessages` array.
type ConversationResetKeys =
  | 'agentMessages'
  | 'agentError'
  | 'agentConversationId'
  | 'agentActiveCredentialId'
  | 'agentActiveModelId'
  | 'agentUsage'
  | 'agentComposerEpoch'

export function emptyConversationUsage(): AgentConversationUsage {
  return {
    contextTokens: null,
    contextCredentialId: null,
    contextModelId: null,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  }
}

export function conversationResetState(agentComposerEpoch: number): Pick<AgentSlice, ConversationResetKeys> {
  return {
    agentMessages: [],
    agentError: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentUsage: emptyConversationUsage(),
    agentComposerEpoch,
  }
}

/**
 * Surface a terminal send error in a SINGLE draft mutation (F10): set
 * `agentError` and add the assistant placeholder block together so the panel
 * renders once, not twice. The placeholder only lands if the assistant message
 * is still empty — i.e. no streamed text/tool blocks arrived before the failure.
 */
export function surfaceAssistantError(
  set: EditorStoreSet,
  assistantId: string,
  error: string,
  placeholder: string,
): void {
  set((state) => {
    state.agentError = error
    const msg = state.agentMessages.find((m) => m.id === assistantId)
    failPendingToolCalls(msg, error)
    if (msg && msg.blocks.length === 0) {
      msg.blocks.push({ kind: 'text', text: placeholder })
    }
  })
}
