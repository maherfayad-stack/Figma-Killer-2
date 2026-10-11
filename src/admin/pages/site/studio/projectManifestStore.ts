/**
 * projectManifestStore - the open project's own package.json (dependencies,
 * devDependencies) and which of it is installed, for the Dependencies panel.
 *
 * The panel used to list the CMS site's in-memory package mirror, so a project
 * with four declared packages read "No dependencies yet." The truth is on disk:
 * `GET /admin/api/studio/install/status` already reads the project's app root
 * and now carries the manifest. One request per project, shared, and refetched
 * by {@link invalidateProjectManifest} when an install or removal lands - the
 * previous answer stays up meanwhile so the list does not blank out.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { probeDependencyInstall, type InstallProbeStatus } from './installDeps'

const manifests = new Map<string, InstallProbeStatus>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function fetchManifest(dir: string): Promise<void> {
  const pending = inFlight.get(dir)
  if (pending) return pending
  const request = probeDependencyInstall(dir)
    .then((status) => {
      manifests.set(dir, status)
      notify()
    })
    .catch((err: unknown) => {
      console.error('[projectManifestStore] could not read the project manifest:', err)
    })
    .finally(() => {
      inFlight.delete(dir)
    })
  inFlight.set(dir, request)
  return request
}

/** Re-read the manifest after an install or removal. Chains after a request already in flight, which may predate the change. */
export function invalidateProjectManifest(dir: string): Promise<void> {
  const pending = inFlight.get(dir)
  if (!pending) return fetchManifest(dir)
  return pending.then(() => fetchManifest(dir))
}

/** The project's manifest + install state, or `null` until the first answer. */
export function useProjectManifest(dir: string | null): InstallProbeStatus | null {
  const manifest = useSyncExternalStore(
    subscribe,
    () => (dir ? (manifests.get(dir) ?? null) : null),
    () => null,
  )
  useEffect(() => {
    if (dir && !manifests.has(dir)) void fetchManifest(dir)
  }, [dir])
  return manifest
}

/** Test-only: bun runs every file in one process. */
export function __resetProjectManifestForTests(): void {
  manifests.clear()
  inFlight.clear()
}
