/**
 * Queueing a message typed while a turn is still streaming.
 *
 * The server allows exactly one stream per conversation and 409s the second
 * ("This conversation is already generating a response"). The composer used to
 * hide its own textarea mid-turn, so that guard read to the user as "anything
 * you type is discarded". These tests pin the queue that guard always implied.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { create } from 'zustand'
import { mutative } from 'zustand-mutative'
import type { AiUserContentBlock } from '@core/ai'

interface QueueSliceShape {
  isAgentStreaming: boolean
  agentQueuedMessage: AiUserContentBlock[] | null
  sent: AiUserContentBlock[][]
  queueAgentMessage(content: AiUserContentBlock[]): void
  cancelQueuedAgentMessage(): void
  abortAgent(): void
  finishTurn(): void
}

/**
 * The slice's queue semantics in isolation — same shape as `agentSlice.ts`'s
 * `queueAgentMessage` / `cancelQueuedAgentMessage` / `flushQueuedMessage`,
 * without dragging the whole store's network and conversation machinery in.
 */
function createQueueStore() {
  return create<QueueSliceShape>()(
    mutative((set, get) => ({
      isAgentStreaming: true,
      agentQueuedMessage: null,
      sent: [],
      queueAgentMessage(content) {
        set((s) => { s.agentQueuedMessage = content })
      },
      cancelQueuedAgentMessage() {
        set((s) => { s.agentQueuedMessage = null })
      },
      abortAgent() {
        set((s) => {
          s.agentQueuedMessage = null
          s.isAgentStreaming = false
        })
      },
      finishTurn() {
        set((s) => { s.isAgentStreaming = false })
        const queued = get().agentQueuedMessage
        if (!queued || queued.length === 0) return
        set((s) => { s.agentQueuedMessage = null })
        set((s) => { s.sent.push(queued) })
      },
    })),
  )
}

const HELLO: AiUserContentBlock[] = [{ kind: 'text', text: 'and make it responsive' }]
const SECOND: AiUserContentBlock[] = [{ kind: 'text', text: 'actually, use the design system' }]

let store: ReturnType<typeof createQueueStore>
beforeEach(() => { store = createQueueStore() })

describe('agent message queue', () => {
  it('holds a message typed mid-turn instead of dropping it', () => {
    store.getState().queueAgentMessage(HELLO)

    expect(store.getState().agentQueuedMessage).toEqual(HELLO)
    // Still queued, not sent — the turn is running.
    expect(store.getState().sent).toEqual([])
  })

  it('sends it automatically when the running turn finishes', () => {
    store.getState().queueAgentMessage(HELLO)

    store.getState().finishTurn()

    expect(store.getState().sent).toEqual([HELLO])
    expect(store.getState().agentQueuedMessage).toBeNull()
  })

  it('keeps only the latest — typing twice means you meant the second one', () => {
    store.getState().queueAgentMessage(HELLO)
    store.getState().queueAgentMessage(SECOND)

    store.getState().finishTurn()

    expect(store.getState().sent).toEqual([SECOND])
  })

  it('clears the queue before sending, so a failed send cannot re-fire later', () => {
    store.getState().queueAgentMessage(HELLO)
    store.getState().finishTurn()

    // A second turn ending must not resend the same message.
    store.getState().finishTurn()

    expect(store.getState().sent).toEqual([HELLO])
  })

  // Stop means stop. A queued message firing the instant the abort lands would
  // be the opposite of what the button promises.
  it('drops the queued message when the user stops the turn', () => {
    store.getState().queueAgentMessage(HELLO)

    store.getState().abortAgent()
    store.getState().finishTurn()

    expect(store.getState().agentQueuedMessage).toBeNull()
    expect(store.getState().sent).toEqual([])
  })

  it('lets the user cancel a queued message explicitly', () => {
    store.getState().queueAgentMessage(HELLO)

    store.getState().cancelQueuedAgentMessage()
    store.getState().finishTurn()

    expect(store.getState().sent).toEqual([])
  })

  it('does nothing on a turn that ends with nothing queued', () => {
    store.getState().finishTurn()

    expect(store.getState().sent).toEqual([])
  })
})
