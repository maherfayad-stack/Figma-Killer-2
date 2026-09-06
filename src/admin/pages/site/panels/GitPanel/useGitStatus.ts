/**
 * useGitStatus — the Git panel's single source of "what does the repository
 * look like right now".
 *
 * One loader, one `refresh`, shared by every action in the panel. The panel
 * deliberately does NOT poll: git status is only interesting after something
 * happens, and everything that can happen either goes through this panel (which
 * refreshes explicitly) or through a canvas save. A timer would spend a
 * subprocess every few seconds to learn nothing.
 *
 * `{ isRepo: false }` is a normal, non-error state — see `gitRequests.ts`.
 *
 * ## Why `loading` is derived rather than set
 *
 * The obvious shape — `setLoading(true)` at the top of the effect — is a
 * synchronous setState inside an effect body, which `react-hooks/set-state-in-
 * effect` rejects: it forces a second render before the fetch has even started.
 * Instead each settled result records the request KEY it answered, and
 * `loading` is "the current key has no answer yet". Same information, no
 * cascading render, and it makes the stale-while-revalidating behaviour
 * explicit: the previous status stays on screen during a refresh instead of
 * blanking the panel.
 */
import { useCallback, useEffect, useState } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { getGitStatus, type GitProjectStatus } from '@site/studio/gitRequests'

export interface GitStatusState {
  loading: boolean
  /** Set only for a genuine failure — never for "this project has no repository". */
  error: string | null
  isRepo: boolean
  status: GitProjectStatus | null
  refresh: () => void
}

interface SettledResult {
  /** The request this answered — compared against the current key to derive `loading`. */
  key: string
  isRepo: boolean
  status: GitProjectStatus | null
  error: string | null
}

export function useGitStatus(dir: string | undefined, active: boolean): GitStatusState {
  const [settled, setSettled] = useState<SettledResult | null>(null)
  const [nonce, setNonce] = useState(0)

  // Referenced from a dep array below, so it needs a stable identity the
  // static exhaustive-deps rule can see (React Compiler exception #1).
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const key = `${dir ?? ''}|${nonce}`

  useEffect(() => {
    // Nothing runs until the panel is actually open: reading git status spawns
    // a subprocess, and a hidden-but-mounted panel doing that on every editor
    // load would be a real cost for no one's benefit.
    if (!active) return
    const controller = new AbortController()
    getGitStatus(dir, controller.signal)
      .then((response) => {
        setSettled({ key, isRepo: response.isRepo, status: response.status, error: null })
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        console.error('[GitPanel] failed to read git status:', err)
        setSettled({ key, isRepo: false, status: null, error: getErrorMessage(err, 'Could not read git status') })
      })
    return () => controller.abort()
  }, [dir, active, key])

  return {
    loading: active && settled?.key !== key,
    error: settled?.error ?? null,
    isRepo: settled?.isRepo ?? false,
    // Kept across a refresh on purpose — see the module doc.
    status: settled?.status ?? null,
    refresh,
  }
}
