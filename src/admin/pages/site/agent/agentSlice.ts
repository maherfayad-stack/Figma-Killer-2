/**
 * Agent store slice — drives the AI Assistant panel.
 *
 * The browser opens a streaming NDJSON request against `/admin/api/ai/chat`.
 * The Bun server selects the configured provider credential and model, then
 * streams through the provider-agnostic direct-HTTP runtime.
 * The NDJSON wire protocol and its per-event handling live in `streamEvents.ts`;
 * conversation bootstrap lives in `agentApi.ts`; shared tool-result POSTs live
 * in `@admin/ai/toolResultApi`; provider update reconciliation lives in
 * `agentProviderUpdate.ts`; the site-specific page snapshot lives in `pageContext.ts`.
 * This module owns only the slice factory: state, actions, and the
 * send/stream-read loop.
 *
 * Guideline #254 (Performance):
 *   Text deltas are batched via rAF buffer before committing to the store
 *   to prevent excessive React re-renders during streaming.
 */

import { nanoid } from 'nanoid'
import { useAdminUi } from '@admin/state/adminUi'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { ApiError, isAbortError, responseErrorMessage } from '@core/http'
import { pushToast } from '@ui/components/Toast'
import {
  listConversations,
  getConversation,
  deleteConversation,
} from '@admin/ai/api'
import {
  createConversation,
  rehydrateMessages,
} from './agentApi'
import { readNdjsonStream } from '@admin/ai/ndjsonStream'
import { processStreamEvent, ServerStreamEventSchema } from './streamEvents'
import type {
  AgentConversationUsage,
  AgentSlice,
  AgentSliceConfig,
  AgentSliceGet,
  EditorStoreSet,
} from './agentSliceTypes'
export type {
  AgentConversationUsage,
  AgentSlice,
  AgentSliceConfig,
} from './agentSliceTypes'
import type {
  AgentBridgeRuntime,
  AgentMessage,
  AgentTextStreamSink,
} from './types'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  persistConversationProvider,
  waitForProviderUpdate,
  type ConfirmedProviderSelection,
} from './agentProviderUpdate'
import { failPendingToolCalls } from './toolCallLifecycle'
import { abandonPermissionPrompts, settlePermissionDecision } from './permissionPrompt'
import { loadStudioDefaultInto, resolveStudioCredentials } from './agentDefaultProvider'
import { agentSessionControlsInitialState, createAgentSessionControlsActions, buildChatRequestBody } from './agentSessionControls'

// Session-id is in-memory only. While the editor stays open, follow-up
// messages reuse the SDK session id (Claude has continuity across the
// thread). On page reload the message thread vanishes too, so starting
// fresh is the right behaviour — we don't want a ghost session from a
// thread the user can no longer see. A future "saved conversations" UI
// will persist threads + their session ids explicitly with a "new chat"
// button to start fresh.

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

declare module '@site/store/types' {
  interface EditorStore extends AgentSlice {}
}

/**
 * Ensure a conversation row exists before streaming. Returns the active row id
 * if one is set; otherwise resolves credentials (staged or Studio's default),
 * creates the row, stages the resolved provider, and returns the new id.
 * Returns null when no provider is configured — the caller surfaces the
 * actionable "set up a provider" error.
 */
async function ensureConversationId(
  get: AgentSliceGet,
  set: EditorStoreSet,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted()
  const existing = get().agentConversationId
  if (existing) return existing

  const creds = await resolveStudioCredentials(get, signal)
  if (!creds) return null

  const conv = await createConversation(
    creds.credentialId,
    creds.modelId,
    signal,
  )
  signal.throwIfAborted()
  set((state) => {
    state.agentConversationId = conv.id
    state.agentActiveCredentialId = creds.credentialId
    state.agentActiveModelId = creds.modelId
  })
  return conv.id
}

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

function emptyConversationUsage(): AgentConversationUsage {
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

function conversationResetState(agentComposerEpoch: number): Pick<AgentSlice, ConversationResetKeys> {
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
function surfaceAssistantError(
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

/**
 * Slice factory — the site editor calls this with its snapshot/dispatcher
 * config. Returns a Zustand state creator the host store composes via the
 * usual `...createAgentSlice(config)(...args)` spread.
 *
 * Return type is intentionally an `EditorStoreSliceCreator<AgentSlice>` so
 * the site editor's existing composition keeps working.
 */
export function createAgentSlice(
  config: AgentSliceConfig,
): EditorStoreSliceCreator<AgentSlice> {
  return (set, get) => {
  // AbortController held in closure (not reactive — intentional, not needed in UI)
  let _abortController: AbortController | null = null
  let _conversationLoadEpoch = 0
  // Provider changes for an existing conversation are ordered so rapid picks
  // cannot land in the database out of order. Sending awaits the same queue.
  let _providerUpdateQueue: Promise<void> = Promise.resolve()
  let _confirmedProviderSelection: ConfirmedProviderSelection | null = null

  // rAF-buffered text accumulation (Guideline #254). Pending deltas are
  // flushed once per animation frame, OR explicitly before any tool-call
  // block is added so chronological ordering is preserved.
  let _pendingText = ''
  let _pendingAssistantId = ''
  let _rafHandle = 0

  /**
   * Append `text` to the last text block of `msg`, or push a new text block
   * if the trailing block is a tool call. This is what keeps text/tool
   * ordering chronological — text that arrives after a tool call goes into
   * its own block AFTER the tool, not concatenated into earlier text.
   */
  function appendTextToBlocks(msg: AgentMessage, text: string): void {
    const last = msg.blocks[msg.blocks.length - 1]
    if (last && last.kind === 'text') {
      last.text += text
    } else {
      msg.blocks.push({ kind: 'text', text })
    }
  }

  function flushPendingText() {
    _rafHandle = 0
    if (!_pendingText || !_pendingAssistantId) return
    const text = _pendingText
    const id = _pendingAssistantId
    _pendingText = ''
    set((state) => {
      const msg = state.agentMessages.find((m) => m.id === id)
      if (msg) appendTextToBlocks(msg, text)
    })
  }

  function scheduleFlush() {
    if (_rafHandle === 0) {
      _rafHandle = requestAnimationFrame(flushPendingText)
    }
  }

  function appendTextDelta(assistantId: string, text: string) {
    _pendingAssistantId = assistantId
    _pendingText += text
    scheduleFlush()
  }

  // Single text-stream sink passed into processStreamEvent. The sink's
  // `flush()` is called from the toolCall/toolResult handlers to drain any
  // pending text deltas BEFORE a tool-call block is added — that's what keeps
  // the visual order in the panel chronologically correct.
  const textSink: AgentTextStreamSink = {
    append: appendTextDelta,
    flush: flushPendingText,
  }

  /**
   * Send whatever the user typed while the previous turn was still running.
   *
   * Deferred to a microtask rather than called inline: this runs inside the
   * `finally` of the turn that just ended, and `sendAgentMessage` re-enters the
   * same slice — letting the current call unwind first keeps the two turns
   * strictly sequential instead of nested. The server enforces one stream per
   * conversation anyway (a 409), so overlapping them would simply be refused.
   */
  function flushQueuedMessage(): void {
    const queued = get().agentQueuedMessage
    if (!queued || queued.length === 0) return
    // Cleared BEFORE sending: a send that fails must not leave the message
    // queued to fire again after the next turn.
    set({ agentQueuedMessage: null })
    queueMicrotask(() => {
      void get().sendAgentMessage(queued)
    })
  }

  return {
    // ── State ────────────────────────────────────────────────────────────────
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentConversations: [],
    agentUsage: emptyConversationUsage(),
    isAgentConversationPending: false,
    isAgentProviderPending: false,
    agentComposerEpoch: 0,
    agentPermissionRequest: null,
    agentQueuedMessage: null,
    ...agentSessionControlsInitialState(),

    // ── UI actions ───────────────────────────────────────────────────────────
    openAgent() {
      set({ isAgentOpen: true })
    },

    closeAgent() {
      set({ isAgentOpen: false })
    },

    toggleAgent() {
      set((s) => {
        s.isAgentOpen = !s.isAgentOpen
      })
    },

    ...createAgentSessionControlsActions(set),

    queueAgentMessage(content) {
      // Replaces rather than appends: the composer sends one draft at a time,
      // and a person who types twice while waiting means the second one.
      set({ agentQueuedMessage: content })
    },

    cancelQueuedAgentMessage() {
      set({ agentQueuedMessage: null })
    },

    abortAgent() {
      // Deny before aborting: the CLI is blocked waiting on this answer, and a
      // parked prompt whose turn is being torn down can never be answered.
      abandonPermissionPrompts('You stopped the turn before answering.')
      // Stopping means stop: a message queued behind this turn must not fire
      // as soon as the abort lands.
      set({ agentPermissionRequest: null, agentQueuedMessage: null })
      if (_abortController) _abortController.abort()
      else set({ isAgentStreaming: false })
    },

    resolveAgentPermission(id, behavior) {
      // The card clears in `promptForPermission`'s finally, keyed by id, so a
      // stale click (already answered, already abandoned) is a no-op.
      settlePermissionDecision(id, {
        behavior,
        ...(behavior === 'deny' ? { message: 'You declined this action.' } : {}),
      })
    },

    clearAgentMessages() {
      _conversationLoadEpoch += 1
      _confirmedProviderSelection = null
      set((state) => {
        Object.assign(state, conversationResetState(state.agentComposerEpoch + 1))
        state.isAgentConversationPending = false
        state.isAgentProviderPending = false
      })
    },

    startNewAgentConversation() {
      if (
        get().isAgentStreaming
        || get().isAgentConversationPending
        || get().isAgentProviderPending
      ) return
      // Reset to a fresh conversation, then re-apply Studio's default so the
      // composer stays ready (provider + model picked) instead of dropping to
      // the "choose a model" lock. `loadStudioDefault` only fills the gap when
      // nothing is chosen — exactly the post-reset state.
      get().clearAgentMessages()
      void get().loadStudioDefault()
    },

    async loadAgentConversations() {
      try {
        const conversations = await listConversations()
        set({ agentConversations: conversations })
      } catch (err) {
        console.error('[AgentSlice] Failed to load conversations:', err)
        pushToast({
          kind: 'error',
          title: "Couldn't load conversations",
          body: getErrorMessage(err, 'Failed to load your conversations.'),
          location: 'site-editor',
        })
      }
    },

    async loadAgentConversation(id: string) {
      if (
        get().isAgentStreaming
        || get().isAgentConversationPending
        || get().isAgentProviderPending
      ) return
      const loadEpoch = ++_conversationLoadEpoch
      set({ isAgentConversationPending: true })
      try {
        const conv = await getConversation(id)
        if (loadEpoch !== _conversationLoadEpoch) return
        _confirmedProviderSelection = {
          conversationId: conv.id,
          credentialId: conv.credentialId,
          modelId: conv.modelId,
        }
        set((state) => {
          state.agentConversationId = conv.id
          state.agentActiveCredentialId = conv.credentialId
          state.agentActiveModelId = conv.modelId
          state.agentMessages = rehydrateMessages(conv.messages)
          state.agentError = null
          state.agentUsage = {
            contextTokens: conv.contextTokens > 0 ? conv.contextTokens : null,
            contextCredentialId: conv.contextTokens > 0 ? conv.credentialId : null,
            contextModelId: conv.contextTokens > 0 ? conv.modelId : null,
            promptTokens: conv.promptTokensTotal,
            completionTokens: conv.completionTokensTotal,
            cacheReadTokens: conv.cacheReadTokensTotal,
            cacheCreationTokens: conv.cacheCreationTokensTotal,
            costUsd: conv.costUsdTotal,
          }
          state.agentComposerEpoch += 1
        })
      } catch (err) {
        if (loadEpoch !== _conversationLoadEpoch) return
        console.error('[AgentSlice] Failed to load conversation:', err)
        set({
          agentError: err instanceof ApiError ? err.message : 'Failed to load conversation.',
        })
      } finally {
        if (loadEpoch === _conversationLoadEpoch) {
          set({ isAgentConversationPending: false })
        }
      }
    },

    async deleteAgentConversation(id: string) {
      if (get().isAgentConversationPending || get().isAgentProviderPending) return
      if (get().isAgentStreaming && get().agentConversationId === id) return
      set({ isAgentConversationPending: true })
      try {
        await deleteConversation(id)
        const wasActive = get().agentConversationId === id
        if (wasActive) _conversationLoadEpoch += 1
        if (wasActive) _confirmedProviderSelection = null
        set((state) => {
          state.agentConversations = state.agentConversations.filter((c) => c.id !== id)
          // Deleting the active conversation resets it through the same key-set
          // as clearAgentMessages — including agentError, so a stuck 502/error
          // banner doesn't survive the delete.
          if (state.agentConversationId === id) {
            Object.assign(
              state,
              conversationResetState(state.agentComposerEpoch + 1),
            )
          }
        })
        // If the active chat was the one deleted, re-apply Studio's default so
        // the panel stays ready instead of dropping to the "choose a model" lock.
        if (wasActive) void get().loadStudioDefault()
      } catch (err) {
        console.error('[AgentSlice] Failed to delete conversation:', err)
        pushToast({
          kind: 'error',
          title: "Couldn't delete conversation",
          body: getErrorMessage(err, 'Failed to delete the conversation.'),
          location: 'site-editor',
        })
      } finally {
        set({ isAgentConversationPending: false })
      }
    },

    async setAgentProvider(credentialId: string, modelId: string) {
      if (
        get().isAgentStreaming
        || get().isAgentConversationPending
        || get().isAgentProviderPending
      ) return
      const currentId = get().agentConversationId
      if (currentId && _confirmedProviderSelection?.conversationId !== currentId) {
        _confirmedProviderSelection = {
          conversationId: currentId,
          credentialId: get().agentActiveCredentialId,
          modelId: get().agentActiveModelId,
        }
      }
      // Always reflect the picker selection locally so the dropdown's
      // displayed value updates immediately. Clearing agentError is essential:
      // a prior send with no configured default leaves a sticky "no provider
      // configured" error that keeps the composer disabled — picking a model
      // IS configuring a provider, so the composer must re-enable. The prior
      // context snapshot keeps its owner IDs; the view renders the new model's
      // meter indeterminate until the next response re-measures it.
      set({
        agentActiveCredentialId: credentialId,
        agentActiveModelId: modelId,
        agentError: null,
      })
      if (!currentId) return  // staged for the next conversation-create call
      set({ isAgentProviderPending: true })

      const handledUpdate = _providerUpdateQueue.then(async () => {
        const result = await persistConversationProvider(currentId, credentialId, modelId)

        // A replacement conversation owns the UI now; this request must not
        // mutate its selection or pending state.
        if (get().agentConversationId !== currentId) return

        _confirmedProviderSelection = result.selection
        set({
          agentActiveCredentialId: result.selection?.credentialId ?? null,
          agentActiveModelId: result.selection?.modelId ?? null,
          agentError: result.kind === 'rejected' ? result.message : null,
        })
        if (result.kind === 'rejected') {
          pushToast({
            kind: 'error',
            title: "Couldn't change model",
            body: result.message,
            location: 'site-editor',
          })
        }
      })
      // Later selections and Send wait until rollback/error handling finishes,
      // while this action still resolves after surfacing the operation failure.
      _providerUpdateQueue = handledUpdate
      await handledUpdate
      if (get().agentConversationId === currentId) {
        set({ isAgentProviderPending: false })
      }
    },

    async loadStudioDefault() {
      await loadStudioDefaultInto(set, get)
    },

    // ── sendAgentMessage ─────────────────────────────────────────────────────
    async sendAgentMessage(content) {
      if (
        get().isAgentStreaming
        || get().isAgentConversationPending
        || get().isAgentProviderPending
        || content.length === 0
      ) return { accepted: false }

      const intendedConversationId = get().agentConversationId
      const intendedCredentialId = get().agentActiveCredentialId
      const intendedModelId = get().agentActiveModelId

      const userMsg: AgentMessage = {
        id: nanoid(),
        role: 'user',
        blocks: content.map((block) => block.kind === 'image'
          ? {
              kind: 'image',
              mimeType: block.mimeType,
              src: `data:${block.mimeType};base64,${block.data}`,
            }
          : { ...block }),
        timestamp: Date.now(),
      }

      const assistantId = nanoid()
      const assistantMsg: AgentMessage = {
        id: assistantId,
        role: 'assistant',
        blocks: [],
        timestamp: Date.now(),
      }

      set({ agentError: null, isAgentStreaming: true })

      const controller = new AbortController()
      _abortController = controller
      const bridge: AgentBridgeRuntime = { bridgeId: null }
      let accepted = false

      try {
        // A model picked immediately before Send must reach the conversation
        // row before the chat handler resolves its capability.
        const providerReady = await waitForProviderUpdate(
          _providerUpdateQueue,
          controller.signal,
        )
        if (!providerReady) return { accepted: false }
        if (
          intendedConversationId
          && (
            _confirmedProviderSelection?.conversationId !== intendedConversationId
            || _confirmedProviderSelection.credentialId !== intendedCredentialId
            || _confirmedProviderSelection.modelId !== intendedModelId
          )
        ) return { accepted: false }
        const snapshot = config.buildSnapshot()

        // Lazily create the conversation row (staged picker values or
        // Studio's default). Null means no provider is configured yet.
        const conversationId = await ensureConversationId(
          get,
          set,
          controller.signal,
        )
        if (!conversationId) {
          const message = config.noProviderMessage
            ?? 'No AI provider configured. Open /admin/ai/providers to add a credential, then /admin/ai/defaults to pick one.'
          set({ agentError: message })
          pushToast({ kind: 'error', title: "Couldn't send message", body: message })
          return { accepted: false }
        }
        if (_confirmedProviderSelection?.conversationId !== conversationId) {
          _confirmedProviderSelection = {
            conversationId,
            credentialId: get().agentActiveCredentialId,
            modelId: get().agentActiveModelId,
          }
        }

        const { agentEffort, agentPermissionMode } = get()
        const body = buildChatRequestBody({
          conversationId,
          content,
          snapshot,
          workspaceDir: useAdminUi.getState().studioProject?.dir,
          agentEffort,
          agentPermissionMode,
        })
        const res = await fetch('/admin/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        if (!res.ok) {
          // `responseErrorMessage` owns the "backend is down" case now (an
          // empty 502/503/504 from the dev proxy), so this fallback covers
          // only a real server response that carried no message.
          const fallback = `Agent request failed: ${res.status} ${res.statusText}`
          throw new ApiError(await responseErrorMessage(res, fallback), res.status)
        }

        accepted = true
        set((state) => {
          state.agentMessages.push(userMsg)
          state.agentMessages.push(assistantMsg)
        })
        if (!res.body) throw new Error('Agent response has no body')

        let terminalEventSeen = false
        for await (const event of readNdjsonStream(res.body.getReader(), ServerStreamEventSchema)) {
          if (event.type === 'done' || event.type === 'error') terminalEventSeen = true
          await processStreamEvent(
            event,
            assistantId,
            textSink,
            set,
            bridge,
            controller.signal,
            config.dispatchTool,
            config.buildSnapshot,
          )
        }
        if (!terminalEventSeen) {
          throw new Error(
            'AI response ended before the turn completed. The server may have restarted; send the message again.',
          )
        }

        flushPendingText()
        return { accepted: true }
      } catch (err) {
        // Abort the fetch so any in-flight MCP tool handler on the server
        // rejects cleanly (via destroyBridge in the stream's finally block)
        // instead of waiting forever for a tool-result that won't arrive.
        const requestWasAlreadyAborted = controller.signal.aborted
        controller.abort()

        // Only an AbortError caused by our already-aborted controller is an
        // intentional Stop/teardown. An AbortError raised while the request
        // was active (for example a failed tool-result delivery) is a real
        // operation failure and must remain visible with retry guidance.
        if (requestWasAlreadyAborted && isAbortError(err)) {
          if (accepted) {
            flushPendingText()
            set((state) => {
              const message = state.agentMessages.find((item) => item.id === assistantId)
              failPendingToolCalls(message)
            })
          }
        } else {
          // Admin-only surface (capability gated) — show the actual
          // failure cause so the operator can act. Network / unexpected
          // throws still get a prefix so they're distinguishable from
          // server-classified driver errors.
          const detail = getErrorMessage(err, String(err))
          console.error('[AgentSlice] sendAgentMessage error:', err)
          if (accepted) {
            surfaceAssistantError(set, assistantId, `Agent request failed: ${detail}`, '_(agent error)_')
          } else {
            set({ agentError: detail })
            pushToast({ kind: 'error', title: "Couldn't send message", body: detail })
          }
        }
        return { accepted }
      } finally {
        if (_abortController === controller) {
          _abortController = null
          set({ isAgentStreaming: false })
          flushQueuedMessage()
        }
      }
    },
  }
  }
}
