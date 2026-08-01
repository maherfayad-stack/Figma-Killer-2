import type { EditorStoreSliceCreator } from '@site/store/types'
import type { AiToolOutput, AiUserContentBlock } from '@core/ai'
import type { ConversationView } from '@admin/ai/api'
import type { AgentMessage } from './types'
import type { AgentPermissionRequest, PermissionBehavior } from './permissionPrompt'

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
  resolveAgentPermission(id: string, behavior: PermissionBehavior): void

  /** WS-12 §5.1 session controls — `claudeCli`-only, every other driver ignores both. Initial values + the "never persists" reasoning live in `agentSessionControls.ts`. */
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  agentPermissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  setAgentEffort(effort: AgentSlice['agentEffort']): void
  setAgentPermissionMode(mode: AgentSlice['agentPermissionMode']): void

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
