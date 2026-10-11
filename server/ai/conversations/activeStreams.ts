/**
 * One provider stream per conversation, process-wide.
 *
 * `chat.ts` acquires it before a turn streams (so two tabs cannot interleave
 * assistant/tool rows) and releases it when the turn ends or is abandoned.
 * The "Restart agent session" endpoint and the agent-checkpoint revert route
 * read it: a restart must not race a live turn, and a turn's files must not be
 * reverted while that turn may still be writing them.
 *
 * Split out of `handlers/chat.ts` so a reader does not have to import the
 * chat HTTP handler to ask "is this conversation busy".
 */
const activeChatConversations = new Set<string>()

/**
 * Whether a chat stream is currently in flight for this conversation. Read by
 * the "Restart agent session" endpoint (`conversations.ts`'s `handleRestartSession`)
 * so a restart can't race a live turn server-side — defense in depth on top
 * of the AgentPanel's own disabled-while-streaming control.
 */
export function isConversationStreaming(conversationId: string): boolean {
  return activeChatConversations.has(conversationId)
}

export function acquireConversationStream(conversationId: string): (() => void) | null {
  if (activeChatConversations.has(conversationId)) return null
  activeChatConversations.add(conversationId)
  let released = false
  return () => {
    if (released) return
    released = true
    activeChatConversations.delete(conversationId)
  }
}

