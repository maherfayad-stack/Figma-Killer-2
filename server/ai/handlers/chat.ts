/**
 * POST /admin/api/ai/chat
 *
 * Opens an NDJSON stream against a chat. Body:
 *   {
 *     conversationId: string,
 *     content:        Array<{ kind: 'text' | 'image', ... }>,
 *     snapshot?:      unknown   // live CMS Site editor snapshot for this turn
 *     workspaceDir?:  string    // open Studio project's absolute dir
 *   }
 *
 * The conversation row already carries `(credentialId, modelId)` from when
 * it was created. The handler:
 *   1. Verifies `ai.chat` + ownership of the conversation.
 *   2. Loads + decrypts the credential (rejects if rotated).
 *   3. Resolves the driver for the credential's provider.
 *   4. Validates `workspaceDir` once (`resolveValidatedWorkspaceDir`): it picks
 *      the toolset (Studio vs. CMS `site`; with Studio, the provider picks the
 *      file surface) and the prompt. `claudeCli` re-validates it before using
 *      it as a subprocess `cwd` — this is selection, not a trust decision.
 *   4b. Scopes the turn to a project: the validated dir's project key must
 *      match the conversation's stamped one (409 if it does not), and stamps
 *      an as-yet-unscoped conversation with it (migration 022).
 *   5. Builds an `AiStreamRequest` (system prompt + tools + history).
 *      Write tools are filtered out unless the caller has `ai.tools.write`.
 *   6. Persists the user message, then runs `runChat({ ... })`.
 *   7. Streams NDJSON events back as the driver produces them.
 */

import { safeParseValue } from '@core/utils/typeboxHelpers'
import {
  AI_CHAT_MAX_REQUEST_BYTES,
  AiChatRequestBodySchema,
  type AiChatRequestBody,
  type AiContentBlock,
} from '@core/ai'
import {
  RequestBodyTooLargeError,
  badRequest,
  jsonResponse,
  payloadTooLarge,
  readValidatedBody,
} from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import {
  adoptConversationProjectKey,
  appendMessage,
  listMessagesForConversation,
  readConversationForUser,
  replaceDefaultConversationTitle,
  deriveConversationTitle,
  DEFAULT_CONVERSATION_TITLE,
} from '../conversations/store'
import { projectKeyForValidatedDir } from '../conversations/projectScope'
import {
  buildMessageHistory,
  projectUserImagesForModel,
} from '../conversations/history'
import {
  readCredentialForUser,
  resolveCredentialForDriver,
  touchCredentialLastUsed,
} from '../credentials/store'
import { resolveDriver } from '../drivers'
import { resolveModelCapabilities } from '../drivers/modelCapabilities'
import {
  AiImageInputError,
  canonicaliseAiUserContent,
  preflightAiUserContent,
} from '../inputImages'
import { agentFileAccessForProvider, selectStudioTools } from '../tools'
import { StudioAgentSnapshotSchema } from '../tools/studio/snapshot'
import {
  createBridge,
  createConversationsPersister,
  encodeStreamEvent,
  runChat,
} from '../runtime'
import { normalizeContextTokens } from '../contextTokens'
import { resolveValidatedWorkspaceDir } from '../../handlers/studio/workspaceDir'
import { resolveProjectFidelityMode } from '../../handlers/studio/projectFidelityMode'
import { resolveProjectDesignPolicy } from '../../handlers/studio/projectDesignPolicy'
import { studioAgentUserKey } from '../../handlers/studio/agentUserScope'
import { prepareStudioHttpTurn } from '../studioHttpTurn'
import { compactHistoryForTurn } from '../historyCompaction'
import { registerTurnDesignReferences } from '../../handlers/studio/turnDesignReferences'
import { buildCmsSiteSystemPrompt, buildStudioProjectSystemPrompt } from '../chatSystemPrompt'
import { collectUserSuppliedUrls } from '../mcp/tools/studio/remoteFetchPolicy'
import type { AiStreamEvent } from '../runtime/types'
import type { AiStreamRequest } from '../drivers/types'
import { acquireConversationStream } from '../conversations/activeStreams'
import { routeChatTurnModel } from '../routing/chatTurnModel'
import { createTurnTelemetry } from '../turnTelemetry'
import { REQUEST_ABORTED, abandonTurn, armAbortedReleaseGuard, clientClosedRequest, waitForRequest } from '../chatTurnGuards'



/**
 * Match `/admin/api/ai/chat`. Returns `null` if path doesn't match.
 */
export function tryHandleAiChat(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== '/admin/api/ai/chat') return null
  return handleAiChat(req, db)
}

async function handleAiChat(
  req: Request,
  db: DbClient,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  // `ai.chat` is the read floor for the conversation endpoint — required
  // for every caller. Write tools are filtered separately below based on
  // the caller's `ai.tools.write` capability so a Client granted chat
  // can use the agent for ideas without it being able to mutate the
  // editor store.
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse
  const user = userOrResponse

  let chatBody: AiChatRequestBody | null
  try {
    chatBody = await readValidatedBody(req, AiChatRequestBodySchema, {
      maxBytes: AI_CHAT_MAX_REQUEST_BYTES,
    })
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return payloadTooLarge('Chat request is too large.')
    }
    throw err
  }
  if (!chatBody) return badRequest('Invalid request body.')
  const {
    conversationId,
    content,
    snapshot,
    workspaceDir,
    effort,
    permissionMode,
    maxToolRounds,
    turnCapMs,
    fidelityMode: turnFidelityMode,
    designPolicy: turnDesignPolicy,
  } = chatBody
  // Validated once, reused for both tool selection and prompt assembly below
  // — a client-supplied path is never trusted twice with two different
  // checks that could drift. `null` means either no project is open or the
  // requested dir failed containment (not this project's own real dir, or
  // outside studio-workspace/ entirely) — both degrade to the CMS toolset,
  // never to trusting the raw client value.
  const validatedWorkspaceDir = resolveValidatedWorkspaceDir(workspaceDir)

  // W9-2 — resolved ONCE here, and once is the point: this is the only place
  // that holds both the per-turn value and the account key needed to read the
  // project default off disk, so every consumer downstream (the prompt's
  // static prefix, `studio_compare` via `ToolContextBase`) is looking at the
  // same answer. The two tiers ABOVE this one — an explicit tool argument and
  // the resolved design reference's own `mode` — are per-call and per-page,
  // so they are applied where they are known (`compare.ts`), on top of this.
  //
  // `referenceArmed` is what the derived tier reads: a project with any
  // registered design gets `balanced` (there is something to measure), one
  // with none gets `creative` (there is not). Wrapped because a project whose
  // `.studio/` is unreadable must degrade to "no reference", never take the
  // whole turn down.
  const resolvedFidelityMode = validatedWorkspaceDir
    ? resolveProjectFidelityMode(validatedWorkspaceDir, studioAgentUserKey(user.id), turnFidelityMode)
    : undefined
  // A12's second axis, resolved the same way and for the same reason: the
  // prompt block and `studio_quality_check`'s severities must come from ONE
  // answer, or the agent is graded against a policy it was never told about.
  const resolvedDesignPolicy = validatedWorkspaceDir
    ? resolveProjectDesignPolicy(validatedWorkspaceDir, studioAgentUserKey(user.id), turnDesignPolicy)
    : undefined

  const conversation = await readConversationForUser(db, user.id, conversationId)
  if (!conversation) {
    return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
  }

  // A conversation belongs to one project (migration 022). The one-honest-
  // target invariant, applied to threads: a thread carrying project A's key
  // must never take a turn against project B — its transcript, its warm CLI
  // session, its `--session-id` and its cached board state all describe A,
  // and continuing it against B would silently mix two projects into one
  // history. Refused (409), never quietly re-pointed.
  //
  // Only a genuine disagreement refuses. A turn with NO project open
  // (`validatedWorkspaceDir === null`) cannot contradict a stamped thread —
  // it has no project of its own to contradict it with — and passes through
  // on the CMS toolset exactly as before.
  const turnProjectKey = validatedWorkspaceDir ? projectKeyForValidatedDir(validatedWorkspaceDir) : null
  if (conversation.projectKey && turnProjectKey && conversation.projectKey !== turnProjectKey) {
    return jsonResponse(
      {
        error: `This conversation belongs to the project "${conversation.projectKey}" and cannot be continued from "${turnProjectKey}". Start a new chat for this project.`,
      },
      { status: 409 },
    )
  }
  // First use adopts: a thread started before this column existed, or before
  // a project was open, becomes this project's from here on. Conditional in
  // SQL (`project_key is null`), so two tabs racing cannot double-stamp.
  if (!conversation.projectKey && turnProjectKey) {
    await adoptConversationProjectKey(db, user.id, conversation.id, turnProjectKey)
      .catch((err: unknown) => { console.error('[ai/chat] project-key adoption failed:', err) })
  }
  if (!conversation.credentialId) {
    return jsonResponse(
      { error: 'Conversation has no credential set. Open AI settings to configure a provider.' },
      { status: 400 },
    )
  }

  const credential = await readCredentialForUser(db, user.id, conversation.credentialId)
  if (!credential) {
    return jsonResponse(
      { error: 'Credential not found or no longer accessible.' },
      { status: 404 },
    )
  }
  let resolvedCredential
  try {
    resolvedCredential = await resolveCredentialForDriver(credential)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Credential resolution failed.'
    return jsonResponse({ error: message }, { status: 409 })
  }

  const driver = resolveDriver(credential.providerId)
  let preflight: ReturnType<typeof preflightAiUserContent>
  try {
    preflight = preflightAiUserContent(content)
  } catch (err) {
    if (err instanceof AiImageInputError) {
      return err.status === 413 ? payloadTooLarge(err.message) : badRequest(err.message)
    }
    throw err
  }
  const requestedImage = preflight.images.length > 0

  // AI-25 — the model this turn runs on: the conversation's own, or a cheaper
  // one for the job when the model was Studio's default. Never up, never
  // over a pick, only to a model the key lists (`routing/modelRouting.ts`).
  const turnModel = await waitForRequest(routeChatTurnModel({
    driver,
    credentials: resolvedCredential,
    conversation,
    userText: content.flatMap((block) => (block.kind === 'text' ? [block.text] : [])).join('\n'),
    attachmentCount: preflight.images.length,
    workspaceDir: validatedWorkspaceDir,
    userId: user.id,
    fidelityMode: resolvedFidelityMode,
    signal: req.signal,
  }), req.signal)
  if (turnModel === REQUEST_ABORTED) return clientClosedRequest()

  // Resolve every selected model, not only image-bearing turns: the same
  // authoritative flag also gates browser-tool screenshots. Model-specific
  // drivers are cached/de-duplicated by the shared resolver.
  const modelCapabilities = await waitForRequest(
    resolveModelCapabilities(driver, resolvedCredential, turnModel.modelId),
    req.signal,
  )
  if (modelCapabilities === REQUEST_ABORTED) return clientClosedRequest()
  // The CLI brings native file tools; every HTTP driver gets Studio's (AI-2). The prompt reads this same array.
  const fileAccess = agentFileAccessForProvider(credential.providerId)
  const tools = selectStudioTools(user.capabilities, { studioProjectOpen: validatedWorkspaceDir !== null, fileAccess, planMode: permissionMode === 'plan' })
  if (requestedImage && !modelCapabilities.visionInput) {
    return jsonResponse(
      { error: 'The selected model does not support image input. Choose a vision-capable model.' },
      { status: 422 },
    )
  }
  if (tools.length > 0 && !modelCapabilities.toolCalling) {
    return jsonResponse(
      { error: 'The selected model does not support tool calling. Choose an agent-capable model.' },
      { status: 422 },
    )
  }
  if (req.signal.aborted) return clientClosedRequest()

  // One provider stream may write a conversation at a time so concurrent tabs
  // cannot interleave assistant/tool rows. Acquire admission before the
  // expensive Sharp boundary: the retryable loser must not decode eight images
  // only to discover that another request already owns the conversation.
  const releaseConversation = acquireConversationStream(conversation.id)
  if (!releaseConversation) {
    return jsonResponse(
      { error: 'This conversation is already generating a response. Wait for it to finish.' },
      { status: 409 },
    )
  }
  if (req.signal.aborted) {
    releaseConversation()
    return clientClosedRequest()
  }

  // Full decode/re-encode is deliberately after the capability gates so an
  // incompatible selected model cannot force needless Sharp work.
  let userContent: AiContentBlock[]
  try {
    userContent = await canonicaliseAiUserContent(preflight, req.signal)
  } catch (err) {
    releaseConversation()
    if (req.signal.aborted) return clientClosedRequest()
    if (err instanceof AiImageInputError) {
      return err.status === 413 ? payloadTooLarge(err.message) : badRequest(err.message)
    }
    throw err
  }
  if (req.signal.aborted) {
    releaseConversation()
    return clientClosedRequest()
  }

  let existingRecords: Awaited<ReturnType<typeof listMessagesForConversation>>
  let latestConversation: NonNullable<Awaited<ReturnType<typeof readConversationForUser>>>
  try {
    const refreshedConversation = await readConversationForUser(db, user.id, conversation.id)
    if (!refreshedConversation) {
      releaseConversation()
      return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
    }
    latestConversation = refreshedConversation
    if (
      latestConversation.credentialId !== conversation.credentialId
      || latestConversation.modelId !== conversation.modelId
    ) {
      releaseConversation()
      return jsonResponse(
        { error: 'The conversation model changed while this message was being prepared. Send again.' },
        { status: 409 },
      )
    }
    existingRecords = await listMessagesForConversation(db, conversation.id)
  } catch (err) {
    releaseConversation()
    throw err
  }
  if (req.signal.aborted) {
    releaseConversation()
    return clientClosedRequest()
  }
  const prepared = await (async () => {
    try {
      // Append the user's message BEFORE streaming so it's persisted even if
      // the stream aborts mid-response.
      const appendedMessage = await appendMessage(db, conversation.id, {
        role: 'user',
        content: userContent,
      })

      // The first prompt names the conversation: replace the placeholder title
      // with an excerpt of what the user asked for. Only fires while the title
      // is still the default, so a user-renamed chat is never overwritten.
      if (latestConversation.title === DEFAULT_CONVERSATION_TITLE) {
        const text = userContent.find((block) => block.kind === 'text')
        const imageCount = userContent.filter((block) => block.kind === 'image').length
        const derivedTitle = text?.kind === 'text'
          ? deriveConversationTitle(text.text)
          : imageCount === 1 ? 'Image' : 'Images'
        if (derivedTitle) {
          await replaceDefaultConversationTitle(db, user.id, conversation.id, derivedTitle)
            .catch((err) => { console.error('[ai/chat] auto-title failed:', err) })
        }
      }

      const messages = projectUserImagesForModel(
        buildMessageHistory([...existingRecords, appendedMessage]),
        modelCapabilities.visionInput,
      )
      // An image attached to a turn with a Studio project open IS the design
      // to match — arm it as a durable reference BEFORE the prompt is built,
      // so the live digest below reports what `studio_compare` can measure
      // against this turn. Idempotent by content hash and never fatal; see
      // `registerTurnDesignReferences`.
      //
      // Scoped to the page the user was looking at: `activePageId` comes
      // straight off the SAME `StudioAgentSnapshot` the live digest below is
      // built from (`buildStudioProjectSystemPrompt` parses it again for the
      // rest of the digest) — never re-derived by a second path. Parsed here,
      // silently, because an invalid/absent snapshot degrading to "register
      // unscoped" is not itself an error worth logging twice; the later parse
      // in `buildStudioProjectSystemPrompt` still logs if the snapshot is
      // malformed. Unscoped means the pasted reference can only ever be found
      // again by explicit id or as "most recent project-wide" — the same
      // fallback that existed before this fix, not a new failure mode.
      if (validatedWorkspaceDir && preflight.imageBytes.length > 0) {
        const parsedSnapshotForReferenceScope = safeParseValue(StudioAgentSnapshotSchema, snapshot)
        const activePageId = parsedSnapshotForReferenceScope.ok
          ? (parsedSnapshotForReferenceScope.value.activePageId ?? undefined)
          : undefined
        await registerTurnDesignReferences(validatedWorkspaceDir, preflight.imageBytes, activePageId)
      }

      // Plain text of THIS turn's own message — threaded through to the live
      // digest's Figma-URL nudge (verification-gate item 4) only; never
      // persisted anywhere beyond that regex check.
      const userMessageText = userContent
        .filter((block): block is Extract<AiContentBlock, { kind: 'text' }> => block.kind === 'text')
        .map((block) => block.text)
        .join('\n')

      const systemPrompt = validatedWorkspaceDir
        ? await buildStudioProjectSystemPrompt(validatedWorkspaceDir, snapshot, conversation.id, tools, { userId: user.id }, userMessageText, resolvedFidelityMode, resolvedDesignPolicy)
        : buildCmsSiteSystemPrompt(snapshot)

      // Capture totals reported by the persister so the audit row can hold
      // them when the stream completes (we read them off the conversation row
      // diff post-stream — see the post-loop block).
      const tokensAtStart = {
        prompt: latestConversation.promptTokensTotal,
        completion: latestConversation.completionTokensTotal,
        cost: latestConversation.costUsdTotal,
      }

      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'ai.chat.started',
        targetType: 'ai_conversation',
        targetId: conversation.id,
        metadata: {
          providerId: credential.providerId,
          modelId: turnModel.modelId,
        },
      })
      return { messages, systemPrompt, tokensAtStart, turnId: appendedMessage.id }
    } catch (err) {
      releaseConversation()
      throw err
    }
  })()
  const { messages, systemPrompt, tokensAtStart, turnId } = prepared

  // `req.signal` covers request-side aborts, but a streaming response consumer
  // can disappear independently (tab reload, dev-server hot restart, proxy
  // disconnect). Own a second lifecycle signal and abort it from the response
  // stream's `cancel()` hook or when enqueue proves the consumer is gone.
  const streamAbort = new AbortController()
  const turnSignal = AbortSignal.any([req.signal, streamAbort.signal])

  // Aborts ONLY when the guard below actually force-releases the lock — see
  // `abandonTurn` and `runChat`'s `abandonedSignal` doc. Threaded into
  // `runChat` so an abandoned turn can never interleave writes with whatever
  // NEW turn now legitimately holds this conversation.
  const turnDeath = new AbortController()

  // See `armAbortedReleaseGuard`'s doc comment: the lock this releases must
  // not depend on the driver's own promise ever settling.
  const disposeAbortedReleaseGuard = armAbortedReleaseGuard(
    turnSignal,
    () => abandonTurn(turnDeath, releaseConversation),
  )

  // One `kind: 'turn'` line in the project's telemetry (AI-25).
  const telemetry = createTurnTelemetry({
    dir: validatedWorkspaceDir,
    conversationId: conversation.id,
    providerId: credential.providerId,
    conversationModelId: conversation.modelId,
    route: turnModel,
    fidelityMode: resolvedFidelityMode,
  })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let streamClosed = false
      let destroyBridge: (() => void) | null = null
      let streamError: string | null = null

      const closeStream = () => {
        if (streamClosed) return
        streamClosed = true
        try { controller.close() } catch { /* already closed */ }
      }
      const emit = (event: AiStreamEvent): void => {
        telemetry.observe(event)
        if (streamClosed) return
        if (event.type === 'error') streamError = event.message
        // Inject the live "context used" count onto each per-round `context`
        // event: the provider-normalised input the model held that round.
        // Drivers report raw token buckets; the handler knows the provider, so
        // it normalises here for the composer meter. (The window is resolved
        // client-side from the model catalogue, so it isn't carried on the
        // wire.) `usage` stays billing-only — the meter is driven by `context`.
        const wireEvent: AiStreamEvent =
          event.type === 'context'
            ? { ...event, contextTokens: normalizeContextTokens(credential.providerId, event) }
            : event
        try {
          controller.enqueue(encodeStreamEvent(wireEvent))
        } catch {
          streamClosed = true
          streamAbort.abort()
        }
      }

      try {
        // Mutable per-turn context. `snapshot` starts at the value the browser
        // posted with the request and is refreshed in place by the bridge's
        // onSnapshot after each mutating browser tool — so a read tool run
        // later in the same turn sees current state, not stale turn-start state.
        const toolContextBase = {
          db,
          userId: user.id,
          capabilities: user.capabilities,
          conversationId: conversation.id,
          // The default target for every Studio tool's optional `dir`. Without
          // it they fall back to "first project alphabetically", which silently
          // pointed the agent at a project the user was not looking at.
          workspaceDir: validatedWorkspaceDir ?? undefined,
          fidelityMode: resolvedFidelityMode,
          designPolicy: resolvedDesignPolicy,
          // The user's own pasted URLs: what an agent may fetch beyond the fixed hosts (`remoteFetchPolicy.ts`).
          userSuppliedUrls: collectUserSuppliedUrls(messages),
          // The persisted user message that opened this turn: its checkpoint key (AI-7).
          turnId,
          snapshot,
        }
        const { bridgeId, bridge, destroy } = createBridge(
          emit,
          turnSignal,
          undefined,
          (next) => { toolContextBase.snapshot = next },
        )
        destroyBridge = destroy
        emit({ type: 'bridgeReady', bridgeId })
        // Which turn this is, so the panel can list and revert what it changes (AI-7).
        emit({ type: 'turn', turnId })
        emit({ type: 'modelRouting', mode: turnModel.mode, modelId: turnModel.modelId, role: turnModel.role, reason: turnModel.reason })

        const request: AiStreamRequest = {
          systemPrompt,
          // Full conversation history — direct HTTP drivers replay it every
          // turn (there is no server-side session to resume) — with its older
          // part summarised once it outgrows the window (AI-18).
          messages: await compactHistoryForTurn({
            db, conversationId: conversation.id, modelId: turnModel.modelId, credentials: resolvedCredential, messages, toolContextBase, signal: turnSignal,
          }),
          tools,
          modelId: turnModel.modelId,
          modelCapabilities,
          credentials: resolvedCredential,
          signal: turnSignal,
          bridge,
          toolContextBase,
          workspaceDir,
          effort,
          permissionMode,
          maxToolRounds,
          turnCapMs,
          fidelityMode: resolvedFidelityMode,
          sessionEpoch: latestConversation.sessionEpoch,
        }

        // What `claudeCli.ts` does before its spawn (guide + fresh turn-write log) — only for a caller who may write (review of #233, F7).
        if (validatedWorkspaceDir && tools.some((t) => t.name === 'studio_write_file')) {
          prepareStudioHttpTurn(validatedWorkspaceDir, { userId: user.id, conversationId: conversation.id, turnId })
        }

        // Priced as the model that actually ran.
        const persister = createConversationsPersister(db, conversation.id, {
          providerId: credential.providerId,
          modelId: turnModel.modelId,
        })
        await runChat({ driver, request, persister, emit, abandonedSignal: turnDeath.signal })

        // Best-effort: record that this credential was used.
        await touchCredentialLastUsed(db, credential.id).catch(() => { /* noop */ })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        // Full Error preserves the stack trace in the operator's terminal.
        console.error('[ai/chat] stream failed:', err)
        streamError = detail
        emit({ type: 'error', message: `AI chat failed: ${detail}` })
      } finally {
        if (destroyBridge) destroyBridge()
        // Emit the terminal audit event. Re-read the conversation row to
        // capture the deltas the persister just committed.
        try {
          const post = await readConversationForUser(db, user.id, conversation.id)
          const promptDelta = post ? post.promptTokensTotal - tokensAtStart.prompt : 0
          const completionDelta = post ? post.completionTokensTotal - tokensAtStart.completion : 0
          const costDelta = post ? Number((post.costUsdTotal - tokensAtStart.cost).toFixed(6)) : 0
          telemetry.finish({ promptTokens: promptDelta, completionTokens: completionDelta, aborted: turnSignal.aborted })
          await createAuditEvent(db, {
            actorUserId: user.id,
            action: streamError ? 'ai.chat.failed' : 'ai.chat.completed',
            targetType: 'ai_conversation',
            targetId: conversation.id,
            metadata: {
              providerId: credential.providerId,
              modelId: turnModel.modelId,
              promptTokens: promptDelta,
              completionTokens: completionDelta,
              costUsd: costDelta,
              ...(streamError ? { error: streamError.slice(0, 200) } : {}),
            },
          })
        } catch (auditErr) {
          // Audit failures must never break the user-visible stream — the
          // request already finished by the time we hit this branch.
          console.error('[ai/chat] audit emit failed:', auditErr)
        } finally {
          disposeAbortedReleaseGuard()
          releaseConversation()
          closeStream()
        }
      }
    },
    cancel() {
      // Abort provider fetches and pending browser waiters immediately; the
      // handler's finally block then destroys the bridge and releases the
      // per-conversation writer lock.
      streamAbort.abort()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'private, no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

// Re-exported so `server/ai/handlers/chat` stays their import path; they live in
// `../chatSystemPrompt.ts` because they never touch a `Request` (ai-handlers-capability-gated).
export { buildCmsSiteSystemPrompt, buildStudioProjectSystemPrompt } from '../chatSystemPrompt'
