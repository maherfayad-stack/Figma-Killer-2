import type { EditorStoreSliceCreator } from '@site/store/types'
import type { AiToolOutput, AiUserContentBlock } from '@core/ai'
import type { ConversationView } from '@admin/ai/api'
import type { AgentMessage, AgentRoutedTurn } from './types'
import type { AgentPermissionRequest, PermissionBehavior } from './permissionPrompt'
import type { AgentRevertResult, AgentTurnChanges } from './agentTurnChanges'

export interface AgentSliceConfig {
  /**
   * Build the per-request snapshot. The slice has no knowledge of the host
   * store's shape; the config closure pulls from whatever store the host
   * mounted the agent in.
   */
  buildSnapshot(): unknown
  /**
   * Dispatch a write-tool request. The slice forwards the server's
   * `toolRequest` event to this function and POSTs the result back.
   */
  dispatchTool(toolName: string, input: unknown): Promise<AiToolOutput>
  /**
   * Optional copy override for the "no AI provider configured" error.
   */
  readonly noProviderMessage?: string
}

/**
 * Usage attached to the active conversation.
 *
 * `contextTokens` is the latest provider round's input size, while the other
 * fields are cumulative billing totals across every round in the conversation.
 * Keeping both in one snapshot makes that distinction explicit at call sites.
 */
export interface AgentConversationUsage {
  contextTokens: number | null
  /** Selection that produced `contextTokens`; null until the first measured round. */
  contextCredentialId: string | null
  contextModelId: string | null
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export interface AgentSlice {
  isAgentOpen: boolean
  isAgentStreaming: boolean
  agentMessages: AgentMessage[]
  agentError: string | null
  agentConversationId: string | null
  agentActiveCredentialId: string | null
  agentActiveModelId: string | null
  agentConversations: ConversationView[]
  agentUsage: AgentConversationUsage
  /** True while a history load/delete can replace the active conversation. */
  isAgentConversationPending: boolean
  /** True while an existing conversation's provider/model update is pending. */
  isAgentProviderPending: boolean
  /** Remounts local composer drafts on explicit conversation replacement. */
  agentComposerEpoch: number

  /**
   * The tool call the CLI is currently blocked on, waiting for the user to
   * approve or decline — null whenever nothing is being asked. At most one is
   * ever outstanding, because the CLI stops and waits for each answer.
   * See `permissionPrompt.ts`.
   */
  agentPermissionRequest: AgentPermissionRequest | null
  /** `message` is what a denial tells the agent — the plan card's "revise without these steps". */
  resolveAgentPermission(id: string, behavior: PermissionBehavior, message?: string): void

  /**
   * A message typed while a turn was still streaming, sent automatically once
   * that turn finishes. The server allows exactly one stream per conversation
   * (409 otherwise), so this is the queue that guard always implied but never
   * had — without it, "the agent is busy" silently swallowed what you typed.
   * Holds at most one: the composer sends one draft at a time, and typing
   * twice means you meant the second one.
   */
  agentQueuedMessage: AiUserContentBlock[] | null
  queueAgentMessage(content: AiUserContentBlock[]): void
  cancelQueuedAgentMessage(): void

  /**
   * What the LAST turn was routed to, and why — the read-only half of the
   * effort control. Null until a routing-capable driver reports one (today
   * only `claudeCli`; every other driver ignores effort entirely, so claiming
   * a routed value for them would be a fabrication).
   *
   * `mode: 'pinned'` means `agentEffort` below was set and used verbatim;
   * `'auto'` means the server classified the prompt. Never written by the UI —
   * pinning is done through `setAgentEffort`, which is what makes this
   * read-only rather than a second, competing control.
   */
  agentRoutedTurn: AgentRoutedTurn | null

  /** WS-12 §5.1 session controls — `claudeCli`-only, every other driver ignores both. Initial values + the "never persists" reasoning live in `agentSessionControls.ts`. */
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  agentPermissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  /**
   * W9-2's fidelity mode for this session. `null` means "let the server
   * decide" — the persisted project default, else the derived value (a design
   * reference is registered → balanced; none → creative). Null is a real,
   * useful state and not a missing value: it is how a user says "grade this
   * the way this project is set up to be graded".
   */
  agentFidelityMode: 'creative' | 'balanced' | 'strict' | null
  /**
   * A12's design policy for this session — how much of the project's own
   * design system the agent is held to. `null` means "let the server decide":
   * the persisted project default, else `balanced`.
   *
   * A SECOND axis, not more values on `agentFidelityMode`. Fidelity is about
   * measurement against a reference; this is about adherence to the design
   * system, and the two combine in both directions — see
   * `server/handlers/studio/designPolicy.ts` for the positions that a single
   * combined control could not express.
   */
  agentDesignPolicy: 'follow' | 'balanced' | 'free' | null
  setAgentEffort(effort: AgentSlice['agentEffort']): void
  setAgentPermissionMode(mode: AgentSlice['agentPermissionMode']): void
  setAgentFidelityMode(mode: AgentSlice['agentFidelityMode']): void
  setAgentDesignPolicy(policy: AgentSlice['agentDesignPolicy']): void

  /**
   * AI-28 — the selection (`agentSelectionKey`) the user removed from the
   * conversation with the selection chip's ×. While it is still the
   * selection, the turn's snapshot carries none; any other selection clears
   * the effect by no longer matching.
   */
  agentSelectionDismissed: string | null
  dismissAgentSelection(key: string | null): void

  /**
   * AI-7 — what each agent turn of this conversation changed on disk, keyed by
   * turn id (the persisted id of the user message that opened it). Filled from
   * the server's checkpoint store after every turn and on conversation load;
   * see `agentTurnChanges.ts`.
   */
  agentTurnChanges: Record<string, AgentTurnChanges>
  refreshAgentTurnChanges(): Promise<void>
  /** Put back what a turn changed — all of it, or just `paths`. A refusal comes back as data, never thrown. */
  revertAgentTurn(turnId: string, paths?: readonly string[]): Promise<AgentRevertResult>

  openAgent(): void
  closeAgent(): void
  toggleAgent(): void
  sendAgentMessage(content: AiUserContentBlock[]): Promise<{ accepted: boolean }>
  abortAgent(): void
  clearAgentMessages(): void
  loadAgentConversations(): Promise<void>
  loadAgentConversation(id: string): Promise<void>
  startNewAgentConversation(): void
  deleteAgentConversation(id: string): Promise<void>
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  loadStudioDefault(): Promise<void>
}

export type EditorStoreSet = Parameters<EditorStoreSliceCreator<AgentSlice>>[0]
export type AgentSliceGet = Parameters<EditorStoreSliceCreator<AgentSlice>>[1]
