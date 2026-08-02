/**
 * Chat runner — drives one driver.stream() to completion + persists each
 * event to the DB while forwarding the wire copy to the response stream.
 *
 * Sequence:
 *
 *   1. Handler creates a bridge via `createBridge(emit)` → bridgeId + sink.
 *   2. Handler emits the `bridgeReady` event.
 *   3. Handler calls `runChat({ driver, request, persister, emit })`.
 *   4. `runChat` iterates driver.stream(request), threading every event
 *      through `emit` (NDJSON to browser) AND `persister` (DB writes for
 *      assistant text + tool calls).
 *   5. `runChat` emits a final `done` (or `error`) and returns.
 *
 * No driver-specific knowledge here. The driver is the only thing that
 * touches its SDK; this module just stitches its events into the wire +
 * the database.
 */

import type { ConversationsPersister } from './persister'
import type { AiProvider, AiStreamRequest } from '../drivers/types'
import type { AiStreamEvent } from './types'
import { INTERRUPTED_TOOL_RESULT_ERROR } from '@core/ai'

interface RunChatArgs {
  driver: AiProvider
  request: AiStreamRequest
  persister: ConversationsPersister
  emit(event: AiStreamEvent): void
  /**
   * Aborts the instant this turn's conversation lock is forcibly released out
   * from under it — see `armAbortedReleaseGuard`'s forced-release path in
   * `chat.ts`. This is DELIBERATELY NOT `request.signal`: that aborts on
   * every cancellation (client Stop, dropped tab) and drivers already handle
   * it on their own schedule; `abandonedSignal` only ever aborts once this
   * turn's lock has ALREADY been handed to a new turn, which is the one
   * moment writing is no longer safe.
   *
   * Checked before every remaining persister write (including the trailing
   * "flush what's pending" finalization on every exit path) so an abandoned
   * turn can never interleave writes with whatever turn now legitimately
   * holds the conversation's lock — the guarantee `acquireConversationStream`
   * exists to provide. Optional: `undefined` behaves as "never abandoned",
   * which is every caller that doesn't arm the guard (e.g. direct unit tests
   * of this function).
   */
  abandonedSignal?: AbortSignal
}

/**
 * Run a single chat turn end-to-end. Throws nothing — terminal errors are
 * forwarded as `{ type: 'error', message }` events and the function returns
 * cleanly so the handler can run its finally-block (destroy bridge, close
 * the response stream).
 */
export async function runChat(args: RunChatArgs): Promise<void> {
  const { driver, request, persister, emit, abandonedSignal } = args
  const abandoned = (): boolean => abandonedSignal?.aborted ?? false

  // Per-turn assembly. Drivers stream `text` events as deltas; we
  // accumulate per assistant-message until the next non-text event lands,
  // at which point we flush an assistant row before recording the tool
  // call. This preserves text-then-tool chronological order in the
  // persisted history.
  let pendingAssistantText = ''
  const pendingToolCallsByCallId = new Map<string, { name: string; input: unknown }>()

  async function flushPendingAssistantText(): Promise<void> {
    if (!pendingAssistantText) return
    const text = pendingAssistantText
    pendingAssistantText = ''
    await persister.appendAssistantText(text)
  }

  /**
   * A graceful abort/terminal driver event can arrive after the assistant's
   * tool-call row was persisted but before its result. Close every such pair
   * explicitly so normal cancellation never leaves history dangling. A hard
   * process crash can still interrupt this write; replay/rehydration heals that
   * unavoidable case separately.
   */
  async function finalizePendingToolCalls(): Promise<void> {
    const pendingCalls = [...pendingToolCallsByCallId]
    for (const [toolCallId, pending] of pendingCalls) {
      const event: AiStreamEvent = {
        type: 'toolResult',
        toolCallId,
        toolName: pending.name,
        ok: false,
        error: INTERRUPTED_TOOL_RESULT_ERROR,
      }
      await persister.appendToolResult({
        toolCallId,
        toolName: pending.name,
        ok: false,
        error: INTERRUPTED_TOOL_RESULT_ERROR,
      })
      pendingToolCallsByCallId.delete(toolCallId)
      emit(event)
    }
  }

  try {
    for await (const event of driver.stream(request)) {
      if (abandoned()) {
        // The conversation lock was force-released to a new turn while this
        // one was still running (see `abandonedSignal` doc above) — a NEW
        // turn may already be writing this conversation's history. Stop
        // immediately: no more persistence, no more wire events, no trailing
        // "flush what's pending" finalization either (below/in the catch
        // block — both are gated the same way).
        console.error('[ai/runner] turn abandoned — its conversation lock was force-released to a new turn; refusing to persist further writes')
        return
      }
      // Forward live events immediately. Usage is the one exception: its USD
      // value may need cache-aware server pricing, so that terminal event is
      // emitted after persistence resolves the authoritative cost below.
      if (event.type !== 'usage' && event.type !== 'error') emit(event)

      switch (event.type) {
        case 'text': {
          pendingAssistantText += event.text
          break
        }
        case 'toolCall': {
          await flushPendingAssistantText()
          await persister.appendToolCall({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          })
          // Track only after the declaration row exists. If that write fails,
          // finalization must not append an orphan result for a call the
          // persisted history never declared.
          pendingToolCallsByCallId.set(event.toolCallId, {
            name: event.toolName,
            input: event.input,
          })
          break
        }
        case 'toolResult': {
          const pending = pendingToolCallsByCallId.get(event.toolCallId)
          pendingToolCallsByCallId.delete(event.toolCallId)
          if (!event.ok) {
            // Surface failed tool calls server-side so the operator can
            // correlate a UI red-dot with a stack-trace / driver message
            // in the server log. The browser already sees the error text
            // (inline under the tool badge); this is the other half of
            // the diagnostic loop.
            console.error(
              `[ai/runner] tool failed — ${pending?.name ?? event.toolName} (${event.toolCallId}):`,
              event.error ?? 'no error message',
            )
          }
          await persister.appendToolResult({
            toolCallId: event.toolCallId,
            toolName: pending?.name ?? event.toolName,
            ok: event.ok,
            error: event.error,
          })
          break
        }
        case 'context': {
          // Track the latest round's context size in the persister (in-memory);
          // it's written to the conversation row once, with the final usage
          // event, so the meter restores to the true context on reload.
          persister.recordContext({
            promptTokens: event.promptTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
          })
          break
        }
        case 'usage': {
          await flushPendingAssistantText()
          const costUsd = await persister.recordUsage({
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            costUsd: event.costUsd,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
          })
          emit({ ...event, costUsd })
          break
        }
        case 'error': {
          // Driver reported a terminal error. Flush whatever text accumulated
          // before bailing — the user still sees the partial assistant
          // message in their history. Pending tool outcomes must precede the
          // terminal wire error so the client can finalize its status rows.
          await flushPendingAssistantText()
          await finalizePendingToolCalls()
          emit(event)
          return
        }
        // `bridgeReady`, `toolRequest`, `done`: nothing to persist.
        default:
          break
      }
    }

    if (abandoned()) {
      console.error('[ai/runner] turn abandoned — its conversation lock was force-released to a new turn; refusing to persist the trailing flush')
      return
    }
    // Stream ended without explicit error or done — flush trailing text.
    await flushPendingAssistantText()
    await finalizePendingToolCalls()
    emit({ type: 'done' })
  } catch (err) {
    if (abandoned()) {
      console.error('[ai/runner] turn abandoned — its conversation lock was force-released to a new turn; refusing to persist the crash-recovery flush')
      return
    }
    const detail = err instanceof Error ? err.message : String(err)
    // Log with the full Error (preserves the stack trace in the operator's
    // terminal). Forward a tagged message to the browser so the admin
    // can see the actual cause — this surface is capability-gated to
    // admins, not end users.
    console.error('[ai/runner] driver.stream() threw:', err)
    await flushPendingAssistantText().catch(() => { /* noop */ })
    await finalizePendingToolCalls().catch((finalizeErr) => {
      console.error('[ai/runner] pending tool finalization failed:', finalizeErr)
    })
    emit({ type: 'error', message: `AI runtime error: ${detail}` })
  }
}
