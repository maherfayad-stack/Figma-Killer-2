/**
 * liveCapabilityStore - the client's one copy of "can this project's real app
 * run?" (`GET /admin/api/studio/trust-tier` -> `live`).
 *
 * Three readers need the answer and used to find it three ways: the Live pill
 * fetched it itself, the dev-server prewarm never asked and POSTed `start` into
 * a refusal (logging a console error on every open of a project with no
 * `node_modules`), and the readiness poll kept asking a server that was never
 * going to boot. One store, one request per project, shared by all of them.
 *
 * It is also what makes an install visible without a reload: the answer is
 * cached per project, and an install or remove that lands calls
 * {@link invalidateLiveCapability}, which re-asks the server. Everything that
 * reads the store (the pill's label, the prewarm that starts the dev server, the
 * readiness poll) moves with it.
 *
 * The previous answer stays in place while the new one is in flight, so the pill
 * does not blink out between "needs an install" and "Starting...".
 */
import { useEffect, useSyncExternalStore } from 'react'
import { fetchStudioTrustStatus, type LiveCapability } from './studioProjectTrust'

const capabilities = new Map<string, LiveCapability>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function fetchCapability(dir: string): Promise<void> {
  const pending = inFlight.get(dir)
  if (pending) return pending
  const request = fetchStudioTrustStatus(dir)
    .then((status) => {
      capabilities.set(dir, status.live)
      notify()
    })
    .catch((err: unknown) => {
      console.error('[liveCapabilityStore] could not read the live capability:', err)
    })
    .finally(() => {
      inFlight.delete(dir)
    })
  inFlight.set(dir, request)
  return request
}

/** The last answer for `dir`, or `null` when none has landed. */
export function getLiveCapability(dir: string): LiveCapability | null {
  return capabilities.get(dir) ?? null
}

/**
 * Ask the server again. Call after anything that changes what the project can
 * run: a dependency install or removal finishing.
 */
export function invalidateLiveCapability(dir: string): Promise<void> {
  // A request already in flight may have read the project BEFORE the install
  // landed; chain a fresh one after it rather than trusting it.
  const pending = inFlight.get(dir)
  if (!pending) return fetchCapability(dir)
  return pending.then(() => fetchCapability(dir))
}

/** The project's live capability, fetched once and shared. `null` until the first answer. */
export function useLiveCapability(dir: string | null): LiveCapability | null {
  const capability = useSyncExternalStore(
    subscribe,
    () => (dir ? getLiveCapability(dir) : null),
    () => null,
  )
  useEffect(() => {
    if (dir && !capabilities.has(dir)) void fetchCapability(dir)
  }, [dir])
  return capability
}

/** Test-only: bun runs every file in one process, so a project dir reused across files would read the previous file's answer. */
export function __resetLiveCapabilityForTests(): void {
  capabilities.clear()
  inFlight.clear()
}
