/**
 * Server → browser stream protocol.
 *
 * Owns the NDJSON envelope schema (`ServerStreamEventSchema`) used to validate
 * each line the server emits, and the `processStreamEvent` reducer that folds
 * one validated event into the agent slice's message state.
 *
 * Wire protocol (server → browser, NDJSON, one ServerStreamEvent per line):
 *   bridgeReady   first event; carries bridgeId for tool-result POSTs
 *   text          chunk of assistant text
 *   toolCall      driver issued a tool call (status: pending) — also the
 *                 tick the panel's progress line counts rounds from (A9)
 *   toolResult    a previously-issued tool call completed (ok/error)
 *   toolRequest   server asks the browser to apply a write tool
 *   usage         per-turn token + cost totals
 *   reasoning     extended-thinking text chunk (WS-12 §5.4, unverified —
 *                 see server/ai/drivers/claudeCliEvents.ts's doc comment)
 *   retrying      the provider was momentarily unable and the server is
 *                 re-sending the request (AI-8) — a status, never an error
 *   error         server-side terminal error
 *   done          stream finished cleanly
 *
 * When a `toolRequest` arrives, the browser dispatches it through the
 * executor (which validates inputs and mutates the Zustand store), then POSTs
 * the result via `postToolResult` so the server-side MCP tool handler can
 * return the result to Claude. There is no separate <studio:actions> DSL — every
 * page mutation is a real MCP tool call.
 */

import { nanoid } from 'nanoid'
import { aiToolError, parseTurnStepReport, type AiToolOutput } from '@core/ai'
import { Type } from '@core/utils/typeboxHelpers'
import { postToolResult } from '@admin/ai/toolResultApi'
import type { EditorStoreSet } from './agentSliceTypes'
import type {
  AgentBridgeRuntime,
  AgentTextStreamSink,
  AgentToolCall,
  ServerStreamEvent,
} from './types'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  PERMISSION_REQUEST_TOOL,
  PROPOSE_PLAN_TOOL,
  awaitPermissionDecision,
  describePermissionRequest,
  parsePermissionRequestInput,
  type PermissionDecisionPayload,
} from './permissionPrompt'
import { failPendingToolCalls } from './toolCallLifecycle'

// ---------------------------------------------------------------------------
// Stream-event schema
//
// Discriminated union mirrors ServerStreamEvent from ./types. Tool-input
// payloads pass through as Unknown — the executor validates each call's input
// at the dispatch boundary. The schema here catches malformed envelopes from
// the server, which is the failure mode the streaming reader needs to defend
// against.
// ---------------------------------------------------------------------------

export const ServerStreamEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({
    type: Type.Literal('bridgeReady'),
    bridgeId: Type.String(),
  }),
  Type.Object({ type: Type.Literal('turn'), turnId: Type.String() }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal('toolCall'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
    status: Type.Literal('pending'),
  }),
  Type.Object({
    type: Type.Literal('toolResult'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
    previewImages: Type.Optional(Type.Array(Type.Object({ mimeType: Type.String({ pattern: '^image/(png|jpeg|webp|gif)$' }), data: Type.String({ pattern: '^[A-Za-z0-9+/=]*$' }) }), { maxItems: 8 })),
  }),
  Type.Object({
    type: Type.Literal('toolInputProgress'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    bytes: Type.Number(),
    target: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('usage'),
    promptTokens: Type.Number(),
    completionTokens: Type.Number(),
    costUsd: Type.Number(),
    cacheReadTokens: Type.Optional(Type.Number()),
    cacheCreationTokens: Type.Optional(Type.Number()),
  }),
  Type.Object({
    // Per-round context size — drives the live meter mid-turn. `contextTokens`
    // is the handler-injected, provider-normalised input for that round.
    type: Type.Literal('context'),
    contextTokens: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('reasoning'), text: Type.String() }),
  Type.Object({
    // How this turn's effort was chosen — see `RoutingEvent` in ./types.
    type: Type.Literal('routing'),
    mode: Type.Union([Type.Literal('pinned'), Type.Literal('auto')]),
    effort: Type.String(),
    shape: Type.Optional(Type.String()),
    reason: Type.String(),
  }),
  Type.Object({
    // Which model this turn runs on — see `AgentRoutedModel` in ./types.
    type: Type.Literal('modelRouting'),
    mode: Type.Union([Type.Literal('pinned'), Type.Literal('routed'), Type.Literal('default')]),
    modelId: Type.String(),
    role: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('retrying'),
    attempt: Type.Number(),
    maxAttempts: Type.Number(),
    delayMs: Type.Number(),
    reason: Type.String(),
  }),
  Type.Object({ type: Type.Literal('done') }),
  Type.Object({ type: Type.Literal('error'), message: Type.String() }),
])

// ---------------------------------------------------------------------------
// Stream event processor
// ---------------------------------------------------------------------------

/**
 * Assistant turns currently showing a retry notice. Checked before clearing so
 * the per-token `text` path costs a set lookup, not a store update.
 */
const retryingTurns = new Set<string>()

function clearRetrying(set: EditorStoreSet, assistantId: string): void {
  if (!retryingTurns.delete(assistantId)) return
  set((state) => {
    const msg = state.agentMessages.find((m) => m.id === assistantId)
    if (msg?.retrying) delete msg.retrying
  })
}

export async function processStreamEvent(
  event: ServerStreamEvent,
  assistantId: string,
  textSink: AgentTextStreamSink,
  set: EditorStoreSet,
  bridge: AgentBridgeRuntime,
  signal: AbortSignal | null,
  dispatchTool: (toolName: string, input: unknown) => Promise<AiToolOutput>,
  /**
   * Capture the current scope snapshot AFTER a browser tool runs. Posted with
   * the tool result so the server refreshes the turn context and later read
   * tools see post-mutation state. Optional — omit and no snapshot is sent.
   */
  buildSnapshot?: () => unknown,
): Promise<void> {
  // Anything the turn produces means the provider is answering again, and a
  // turn that ended (done or error) is no longer retrying either.
  if (event.type !== 'retrying' && event.type !== 'context' && event.type !== 'bridgeReady' && event.type !== 'turn') clearRetrying(set, assistantId)

  switch (event.type) {
    case 'retrying': {
      // A status, never an error: the headline says so, and nothing is added
      // to the transcript.
      retryingTurns.add(assistantId)
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (msg) msg.retrying = { attempt: event.attempt, maxAttempts: event.maxAttempts }
      })
      break
    }

    case 'text': {
      textSink.append(assistantId, event.text)
      // A9 — the model reports "step k/N" as it works (the static prompt's
      // "Step budget" section asks for it). Captured here, on the delta,
      // rather than re-scanned from the assembled transcript on every render:
      // the parse is a bounded regex over one chunk and the `set` only runs
      // on the rare chunk that actually carries a report.
      const reported = parseTurnStepReport(event.text)
      if (reported) {
        set((state) => {
          const msg = state.agentMessages.find((m) => m.id === assistantId)
          if (msg) msg.reportedStep = reported
        })
      }
      break
    }

    case 'reasoning': {
      // Flush any pending assistant text first so a reasoning block never
      // gets spliced into the middle of an in-flight text block — same
      // ordering discipline `toolCall` already follows. Reasoning deltas
      // accumulate into the trailing block when one is already open;
      // otherwise a fresh block starts (mirrors the text-delta pattern).
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        const last = msg.blocks.at(-1)
        if (last && last.kind === 'reasoning') {
          last.text += event.text
        } else {
          msg.blocks.push({ kind: 'reasoning', text: event.text })
        }
      })
      break
    }

    case 'bridgeReady': {
      bridge.bridgeId = event.bridgeId
      break
    }

    case 'turn': {
      // The user message this turn answers is the one right before its
      // assistant placeholder — both were pushed together on send.
      set((state) => {
        const index = state.agentMessages.findIndex((m) => m.id === assistantId)
        const userMsg = index > 0 ? state.agentMessages[index - 1] : undefined
        if (userMsg?.role === 'user') userMsg.turnId = event.turnId
      })
      break
    }

    case 'toolRequest': {
      // A permission prompt is a question for the USER, not work for the tool
      // dispatcher — intercepted before dispatch so it never looks for a tool
      // named `permission_request`. The `toolRequest` shape is reused only as
      // transport: the server is awaiting a POST to /tool-result either way.
      if (event.toolName === PERMISSION_REQUEST_TOOL) {
        const parsed = parsePermissionRequestInput(event.input)
        // Fail closed, exactly as the server does: a request we cannot read is
        // one the user cannot meaningfully approve.
        const decision: PermissionDecisionPayload = parsed
          ? await promptForPermission(set, parsed.toolName, parsed.input)
          : { behavior: 'deny', message: 'Studio could not read that permission request.' }
        if (!bridge.bridgeId) {
          console.error('[AgentSlice] permission toolRequest received before bridgeReady')
          break
        }
        await postToolResult(bridge.bridgeId, event.requestId, { ok: true, data: decision }, signal)
        break
      }

      // AI-22 — the HTTP agent's plan, in plan mode: the same card as the
      // CLI's ExitPlanMode prompt, and the answer goes back as the tool's
      // result, which is what lets the agent proceed (or revise).
      if (event.toolName === PROPOSE_PLAN_TOOL) {
        const decision = await promptForPermission(set, PROPOSE_PLAN_TOOL, event.input)
        if (!bridge.bridgeId) {
          console.error('[AgentSlice] plan toolRequest received before bridgeReady')
          break
        }
        const answer = {
          approved: decision.behavior === 'allow',
          ...(decision.message ? { feedback: decision.message } : {}),
        }
        await postToolResult(bridge.bridgeId, event.requestId, { ok: true, data: answer }, signal)
        break
      }

      // Defensive: the dispatcher already converts caught throws into
      // `{ ok: false, error }`, but if anything ever escapes (or if
      // the bridge evolves) we still need to ALWAYS POST a result so the
      // server's bridge resolver fires and the driver loop sees a tool
      // error rather than hanging forever.
      let result: AiToolOutput
      try {
        result = await dispatchTool(event.toolName, event.input)
      } catch (err) {
        const message = getErrorMessage(err, String(err))
        console.error(`[AgentSlice] tool ${event.toolName} threw unexpectedly:`, err)
        result = aiToolError(`Browser exception: ${message}`)
      }
      // A browser tool may return preview images (for example render_snapshot).
      // Stash them on the matching pending tool-call block so the panel can show
      // what the agent looked at. The `toolCall` event for this call already
      // created the block, and tool calls are sequential, so exactly one block
      // for this tool is pending. The full tool result is posted to the active
      // provider turn below, but preview URLs are session-only and are not
      // persisted in conversation history, so they rehydrate empty on reload.
      const previewImages = result.ok
        ? result.images?.map((image) => `data:${image.mimeType};base64,${image.data}`)
        : undefined
      if (previewImages?.length) {
        set((state) => {
          const msg = state.agentMessages.find((m) => m.id === assistantId)
          const block = msg?.blocks.find(
            (b): b is { kind: 'toolCall'; toolCall: AgentToolCall } =>
              b.kind === 'toolCall'
              && b.toolCall.actionType === event.toolName
              && b.toolCall.status === 'pending',
          )
          if (block) block.toolCall.previewImages = previewImages
        })
      }
      if (!bridge.bridgeId) {
        console.error('[AgentSlice] toolRequest received before bridgeReady')
        break
      }
      // Snapshot AFTER the tool ran so the server sees the mutation it made.
      const snapshot = buildSnapshot?.()
      await postToolResult(bridge.bridgeId, event.requestId, result, signal, snapshot)
      break
    }

    case 'toolInputProgress': {
      // AI-26 — throttled server-side (one per KB), so a plain store write.
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (msg) msg.inputProgress = { toolCallId: event.toolCallId, toolName: event.toolName, bytes: event.bytes, ...(event.target ? { target: event.target } : {}) }
      })
      break
    }

    case 'toolCall': {
      // Driver issued a tool call (status: pending). Drain any pending text
      // deltas BEFORE adding the block so the chronological order
      // text → tool → text is preserved.
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        // The call arrived whole: its argument progress is over.
        if (msg.inputProgress) delete msg.inputProgress
        const inputAsRecord = event.input && typeof event.input === 'object'
          ? (event.input as Record<string, unknown>)
          : null
        const existing = msg.blocks.find(
          (block): block is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            block.kind === 'toolCall' && block.toolCall.externalId === event.toolCallId,
        )
        if (existing) {
          // Re-emitted (e.g. Anthropic's content_block_start then _stop):
          // refresh the input but keep the pending status.
          if (inputAsRecord) existing.toolCall.params = inputAsRecord
          return
        }
        msg.blocks.push({
          kind: 'toolCall',
          toolCall: {
            id: nanoid(),
            externalId: event.toolCallId,
            actionType: event.toolName,
            params: inputAsRecord ?? {},
            result: null,
            status: 'pending',
          },
        })
      })
      break
    }

    case 'toolResult': {
      // Paired with the preceding `toolCall` (matched by toolCallId).
      // Flip its status to success/error + attach the result envelope so
      // the UI can render any failure message inline with the badge.
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        const block = msg.blocks.find(
          (b): b is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            b.kind === 'toolCall' && b.toolCall.externalId === event.toolCallId,
        )
        if (!block) return
        block.toolCall.status = event.ok ? 'success' : 'error'
        block.toolCall.result = {
          ok: event.ok,
          error: event.ok ? undefined : event.error ?? 'Tool call failed.',
        }
        // A server-run tool's images (a headless screenshot) — what the agent
        // looked at, and the variants card's thumbnails.
        if (event.previewImages?.length) {
          block.toolCall.previewImages = event.previewImages.map((image) => `data:${image.mimeType};base64,${image.data}`)
        }
      })
      break
    }

    case 'usage': {
      // Billing totals are cumulative across provider rounds and therefore
      // separate from current context. The server resolves authoritative,
      // cache-aware USD cost before this terminal event reaches the browser.
      set((state) => {
        state.agentUsage.promptTokens += event.promptTokens
        state.agentUsage.completionTokens += event.completionTokens
        state.agentUsage.cacheReadTokens += event.cacheReadTokens ?? 0
        state.agentUsage.cacheCreationTokens += event.cacheCreationTokens ?? 0
        state.agentUsage.costUsd = Number(
          (state.agentUsage.costUsd + event.costUsd).toFixed(6),
        )
      })
      break
    }

    case 'routing': {
      // Display only. Stored on the session (not on the message) because it
      // describes the TURN, and the composer chip that shows it has to be
      // readable before the first token arrives.
      set((state) => {
        state.agentRoutedTurn = {
          mode: event.mode,
          effort: event.effort,
          ...(event.shape ? { shape: event.shape } : {}),
          reason: event.reason,
        }
      })
      break
    }

    case 'modelRouting': {
      // Display only, like `routing`: the composer chip names a turn that ran
      // on a cheaper model than the conversation's, with the router's reason.
      set((state) => {
        state.agentRoutedModel = { mode: event.mode, modelId: event.modelId, role: event.role, reason: event.reason }
      })
      break
    }

    case 'context': {
      // Live "context used" meter: each provider round reports the current
      // context size (handler-injected, provider-normalised). Update on every
      // round so the meter climbs DURING a turn, not only at the end. The
      // window half is supplied by the view layer from the model catalogue.
      const used = event.contextTokens
      set((state) => {
        state.agentUsage.contextTokens = used
        state.agentUsage.contextCredentialId = state.agentActiveCredentialId
        state.agentUsage.contextModelId = state.agentActiveModelId
      })
      break
    }

    case 'error': {
      // Surface the server's error message verbatim — drivers already
      // classify and shape these to be user-facing (auth/billing/quota
      // shows actionable copy, raw stack traces are stripped at the driver
      // boundary). The admin needs the actual reason, not a "Something
      // went wrong" placeholder; this surface is admin-only (capability
      // gated) so info-disclosure concerns don't apply.
      console.error('[AgentSlice] Server error event:', event.message)
      set((state) => {
        state.agentError = event.message
        const message = state.agentMessages.find((item) => item.id === assistantId)
        failPendingToolCalls(message, event.message)
      })
      break
    }

    case 'done': {
      // `done` with a pending call is an inconsistent/truncated server turn.
      // Keep the completed response usable, but never leave historical work
      // rendered as though it were still running.
      set((state) => {
        const message = state.agentMessages.find((item) => item.id === assistantId)
        failPendingToolCalls(message)
      })
      break
    }

    default:
      break
  }
}

/**
 * Show the Allow / Deny card and wait for the click. The card is store state so
 * the panel can render it; the promise it resolves is held in
 * `permissionPrompt.ts` (a resolver is not serialisable state). Always clears
 * the card, so a denial, an abort, or a thrown error can't strand it on screen.
 */
async function promptForPermission(
  set: EditorStoreSet,
  toolName: string,
  input: unknown,
): Promise<PermissionDecisionPayload> {
  const request = describePermissionRequest(toolName, input)
  set((state) => {
    state.agentPermissionRequest = request
  })
  try {
    return await awaitPermissionDecision(request.id)
  } finally {
    set((state) => {
      if (state.agentPermissionRequest?.id === request.id) state.agentPermissionRequest = null
    })
  }
}
