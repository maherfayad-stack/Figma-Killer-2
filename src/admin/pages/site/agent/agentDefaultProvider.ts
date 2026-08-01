/**
 * Resolving which provider/model a turn runs on, before a conversation exists.
 *
 * Two entry points share one fetch: `loadStudioDefaultInto` (panel opened, fill
 * the picker) and `resolveStudioCredentials` (first send, need a provider now).
 * Whichever runs first stages the resolved values into the store and the other
 * reuses them, so Studio's default is fetched at most once per panel session.
 *
 * Split out of `agentSlice.ts`, which owns turn/conversation state rather than
 * provider resolution — and had grown past the module-size ceiling.
 */
import { fetchStudioDefault } from './agentApi'
import type { AgentSliceGet, EditorStoreSet } from './agentSliceTypes'

export interface ResolvedCredentials {
  credentialId: string
  modelId: string
}

/**
 * The `(credentialId, modelId)` to use: the staged picker selection when the
 * user has one, otherwise Studio's server-side default. Null means no provider
 * is configured at all — callers surface the actionable "set up a provider"
 * error rather than guessing.
 */
export async function resolveStudioCredentials(
  get: AgentSliceGet,
  signal?: AbortSignal,
): Promise<ResolvedCredentials | null> {
  signal?.throwIfAborted()
  const credentialId = get().agentActiveCredentialId
  const modelId = get().agentActiveModelId
  if (credentialId && modelId) return { credentialId, modelId }
  const credentials = await fetchStudioDefault(signal)
  signal?.throwIfAborted()
  return credentials
}

/**
 * Fill the picker when the panel opens, and only then: this fills the "nothing
 * chosen yet" gap and must never clobber an active conversation's provider or
 * an explicit user pick — including one made WHILE this request was in flight,
 * which is why the same two guards run again after the await.
 */
export async function loadStudioDefaultInto(
  set: EditorStoreSet,
  get: AgentSliceGet,
): Promise<void> {
  if (hasExplicitSelection(get)) return

  let creds: ResolvedCredentials | null
  try {
    creds = await resolveStudioCredentials(get)
  } catch (err) {
    // A failed defaults lookup is soft: leave the picker empty so the user can
    // pick a model. The send-time path still surfaces the actionable
    // no-provider error if they send without choosing.
    console.error('[AgentSlice] Failed to load the default model:', err)
    return
  }

  if (hasExplicitSelection(get)) return
  // No default configured: leave the picker empty (it shows its "Choose a
  // model" placeholder) and let the user pick one.
  if (!creds) return

  set({
    agentActiveCredentialId: creds.credentialId,
    agentActiveModelId: creds.modelId,
    agentError: null,
  })
}

function hasExplicitSelection(get: AgentSliceGet): boolean {
  if (get().agentConversationId) return true
  return Boolean(get().agentActiveCredentialId && get().agentActiveModelId)
}
