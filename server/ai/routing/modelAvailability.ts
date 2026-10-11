/**
 * Which model ids a credential can use — the "only to a model the key can
 * use" rule of `modelRouting.ts`, answered from the provider's own live model
 * list and cached, so routing never adds a catalogue round trip to a turn.
 *
 * Unknown is an answer: a failed or timed-out lookup, or a catalogue made only
 * of fallback entries, returns `null`, and `routeModel` then keeps the
 * conversation's own model. Routing is an optimisation; it must never be the
 * reason a turn fails.
 */
import { createHash } from 'node:crypto'
import { listProviderModels } from '../drivers/modelList'
import type { AiProvider, AiResolvedCredential } from '../drivers/types'

const AVAILABILITY_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 64

interface Entry {
  readonly expiresAt: number
  readonly ids: ReadonlySet<string> | null
}

const cache = new Map<string, Entry>()

/** A key that changes when the credential's backend or secret does, without holding the secret itself. */
function credentialKey(driver: AiProvider, credentials: AiResolvedCredential): string {
  const secret = createHash('sha256').update(`${credentials.apiKey ?? ''}\0${credentials.baseUrl ?? ''}`).digest('hex')
  return `${driver.id}\0${credentials.id}\0${secret}`
}

/** The live model ids for this credential, or `null` when they are not known. Never throws. */
export async function availableModelIds(
  driver: AiProvider,
  credentials: AiResolvedCredential,
  signal?: AbortSignal,
): Promise<ReadonlySet<string> | null> {
  const key = credentialKey(driver, credentials)
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.ids
  let ids: ReadonlySet<string> | null = null
  try {
    const models = await listProviderModels(driver, credentials, signal)
    const live = models.filter((model) => model.catalogueSource !== 'fallback')
    ids = live.length > 0 ? new Set(live.map((model) => model.id)) : null
  } catch (err) {
    if (signal?.aborted) return null
    console.error(`[ai/routing] could not list ${driver.id} models — turns keep their own model:`, err)
  }
  cache.delete(key)
  cache.set(key, { expiresAt: Date.now() + AVAILABILITY_TTL_MS, ids })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return ids
}
