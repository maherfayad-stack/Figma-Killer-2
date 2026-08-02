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
 *   4. Validates `workspaceDir` once (`resolveValidatedWorkspaceDir`) and uses
 *      the result for TWO things (WS-12): which toolset `selectStudioTools`
 *      offers (the real Studio tools vs. the CMS `site` tools), and which
 *      system prompt gets built below. `workspaceDir` is also forwarded
 *      verbatim on `AiStreamRequest` for `claudeCli` (WS-11), which does its
 *      OWN, separate validation before using it as a subprocess `cwd` — this
 *      handler's validation is for tool/prompt selection only, not a trust
 *      decision claudeCli.ts can skip re-making.
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
  appendMessage,
  listMessagesForConversation,
  readConversationForUser,
  replaceDefaultConversationTitle,
  deriveConversationTitle,
  DEFAULT_CONVERSATION_TITLE,
} from '../conversations/store'
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
import { selectStudioTools } from '../tools'
import {
  buildSiteSystemPrompt,
  SiteAgentSnapshotSchema,
  type SiteAgentSnapshot,
} from '../tools/site'
import { buildStudioAgentSystemPrompt, studioPromptContextFromProfile } from '../tools/studio'
import { buildStudioLiveDigest } from '../tools/studio/liveDigest'
import { StudioAgentSnapshotSchema } from '../tools/studio/snapshot'
import {
  createBridge,
  createConversationsPersister,
  encodeStreamEvent,
  runChat,
} from '../runtime'
import { normalizeContextTokens } from '../contextTokens'
import { resolveValidatedWorkspaceDir } from '../../handlers/studio/workspaceDir'
import { resolveProjectProfile } from '../../handlers/studio/projectProbe'
import { readStudioMeta } from '../../handlers/studio/studioMeta'
import { projectDisplayName } from '../../handlers/studioProjects'
import type { AiStreamEvent } from '../runtime/types'
import type { AiStreamRequest } from '../drivers/types'

const activeChatConversations = new Set<string>()
const REQUEST_ABORTED = Symbol('request-aborted')

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
  const { conversationId, content, snapshot, workspaceDir, effort, permissionMode } = chatBody
  // Validated once, reused for both tool selection and prompt assembly below
  // — a client-supplied path is never trusted twice with two different
  // checks that could drift. `null` means either no project is open or the
  // requested dir failed containment (not this project's own real dir, or
  // outside studio-workspace/ entirely) — both degrade to the CMS toolset,
  // never to trusting the raw client value.
  const validatedWorkspaceDir = resolveValidatedWorkspaceDir(workspaceDir)

  const conversation = await readConversationForUser(db, user.id, conversationId)
  if (!conversation) {
    return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
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

  // Resolve every selected model, not only image-bearing turns: the same
  // authoritative flag also gates browser-tool screenshots. Model-specific
  // drivers are cached/de-duplicated by the shared resolver.
  const modelCapabilities = await waitForRequest(
    resolveModelCapabilities(driver, resolvedCredential, conversation.modelId),
    req.signal,
  )
  if (modelCapabilities === REQUEST_ABORTED) return clientClosedRequest()
  const tools = selectStudioTools(user.capabilities, { studioProjectOpen: validatedWorkspaceDir !== null })
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
      const systemPrompt = validatedWorkspaceDir
        ? await buildStudioProjectSystemPrompt(validatedWorkspaceDir, snapshot, conversation.id)
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
          modelId: conversation.modelId,
        },
      })
      return { messages, systemPrompt, tokensAtStart }
    } catch (err) {
      releaseConversation()
      throw err
    }
  })()
  const { messages, systemPrompt, tokensAtStart } = prepared

  // `req.signal` covers request-side aborts, but a streaming response consumer
  // can disappear independently (tab reload, dev-server hot restart, proxy
  // disconnect). Own a second lifecycle signal and abort it from the response
  // stream's `cancel()` hook or when enqueue proves the consumer is gone.
  const streamAbort = new AbortController()
  const turnSignal = AbortSignal.any([req.signal, streamAbort.signal])

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

        const request: AiStreamRequest = {
          systemPrompt,
          // Full conversation history — direct HTTP drivers replay it every
          // turn (there is no server-side session to resume).
          messages,
          tools,
          modelId: conversation.modelId,
          modelCapabilities,
          credentials: resolvedCredential,
          signal: turnSignal,
          bridge,
          toolContextBase,
          workspaceDir,
          effort,
          permissionMode,
          sessionEpoch: latestConversation.sessionEpoch,
        }

        const persister = createConversationsPersister(db, conversation.id, {
          providerId: credential.providerId,
          modelId: conversation.modelId,
        })
        await runChat({ driver, request, persister, emit })

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
          await createAuditEvent(db, {
            actorUserId: user.id,
            action: streamError ? 'ai.chat.failed' : 'ai.chat.completed',
            targetType: 'ai_conversation',
            targetId: conversation.id,
            metadata: {
              providerId: credential.providerId,
              modelId: conversation.modelId,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a chat stream is currently in flight for this conversation. Read by
 * the "Restart agent session" endpoint (`conversations.ts`'s `handleRestartSession`)
 * so a restart can't race a live turn server-side — defense in depth on top
 * of the AgentPanel's own disabled-while-streaming control.
 */
export function isConversationStreaming(conversationId: string): boolean {
  return activeChatConversations.has(conversationId)
}

function acquireConversationStream(conversationId: string): (() => void) | null {
  if (activeChatConversations.has(conversationId)) return null
  activeChatConversations.add(conversationId)
  let released = false
  return () => {
    if (released) return
    released = true
    activeChatConversations.delete(conversationId)
  }
}

function clientClosedRequest(): Response {
  return new Response(null, { status: 499, statusText: 'Client Closed Request' })
}

function waitForRequest<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof REQUEST_ABORTED> {
  if (signal.aborted) return Promise.resolve(REQUEST_ABORTED)
  return new Promise<T | typeof REQUEST_ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(REQUEST_ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * The CMS Site editor's prompt — used whenever no Studio project is open
 * (`validatedWorkspaceDir === null`). Named for what it builds, not for
 * "the Studio agent" (WS-12 §8.1 D3 collapsed that concept to "the one
 * agent"; it does not mean every prompt is the Studio-project one).
 */
export function buildCmsSiteSystemPrompt(snapshot: unknown): string[] {
  if (snapshot === undefined || snapshot === null) {
    return buildSiteSystemPrompt(emptySiteAgentSnapshot())
  }
  // The snapshot comes straight off the untyped HTTP body — validate it
  // before handing it to the prompt builder, and fall back to an empty
  // snapshot (rather than crashing the stream) when it's malformed.
  const result = safeParseValue(SiteAgentSnapshotSchema, snapshot)
  if (!result.ok) {
    console.error('[ai/chat] invalid site snapshot, using empty fallback:', result.errors)
    return buildSiteSystemPrompt(emptySiteAgentSnapshot())
  }
  return buildSiteSystemPrompt(result.value)
}

/**
 * The real Studio-project prompt (WS-12 §4). Project/profile/trust are
 * always built server-side from `dir` — the client never carries them (see
 * `studioAgentSnapshot.ts`'s own doc comment for why). `snapshot` is the
 * browser's lean `StudioAgentSnapshot` live-state (board/selection/axes ids);
 * when present and valid it drives `buildStudioLiveDigest` (WS-12 §2.1's
 * board/activePage/selection/fidelity/install lines, plus the §2.2 staleness
 * warning). Absent or malformed `snapshot` degrades to the profile-only
 * suffix — the static prefix's own tool-based instructions still work with
 * no live digest at all, so this is never a hard failure.
 *
 * Never throws: a profile-probe failure degrades to the "unavailable" suffix
 * rather than falling back to the CMS prompt, which would silently hand the
 * model the wrong tool vocabulary for an open Studio project.
 */
export async function buildStudioProjectSystemPrompt(
  dir: string,
  snapshot: unknown,
  conversationId: string,
  /**
   * Test seam — defaults to the shared production staleness tracker
   * (`studioSnapshotStaleness`). Tests that exercise the §2.2 staleness rule
   * pass their OWN `createStalenessTracker()` instance so their assertions
   * never share state with another test file's run — the exact shape of
   * cross-test pollution `claudeCli.test.ts`'s roster tests hit once already.
   */
  liveDigestOptions?: Parameters<typeof buildStudioLiveDigest>[3],
): Promise<string[]> {
  let ctx: ReturnType<typeof studioPromptContextFromProfile>
  try {
    const trust = readStudioMeta(dir).trust ?? 'static'
    const profile = resolveProjectProfile(dir)
    const name = projectDisplayName(dir)
    ctx = studioPromptContextFromProfile(dir, name, trust, profile)
  } catch (err) {
    console.error('[ai/chat] failed to resolve the studio project profile, using the unavailable fallback:', err)
    return buildStudioAgentSystemPrompt(null)
  }

  let live: Awaited<ReturnType<typeof buildStudioLiveDigest>> | null = null
  const parsedSnapshot = safeParseValue(StudioAgentSnapshotSchema, snapshot)
  if (parsedSnapshot.ok) {
    try {
      live = await buildStudioLiveDigest(dir, parsedSnapshot.value, conversationId, liveDigestOptions)
    } catch (err) {
      console.error('[ai/chat] failed to build the studio live digest, continuing without it:', err)
    }
  } else if (snapshot !== undefined && snapshot !== null) {
    console.error('[ai/chat] invalid studio snapshot, continuing without the live digest:', parsedSnapshot.errors)
  }

  return buildStudioAgentSystemPrompt(ctx, live)
}

function emptySiteAgentSnapshot(): SiteAgentSnapshot {
  return {
    page: {
      id: '',
      title: 'Untitled',
      slug: '',
      rootNodeId: '',
      nodes: {},
    } as SiteAgentSnapshot['page'],
    currentDocument: { type: 'page', id: 'empty' },
    site: {
      pages: [],
      breakpoints: [],
      styleRules: {},
      visualComponents: [],
      settings: { shortcuts: {} },
    } as unknown as SiteAgentSnapshot['site'],
    selectedNodeId: null,
    activeBreakpointId: '',
  }
}
