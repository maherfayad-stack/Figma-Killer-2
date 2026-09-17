/**
 * useGitConflicts — is a rebase or merge stopped on a conflict right now, and
 * which files?
 *
 * Same shape as `useGitStatus.ts`/`useGitBranches.ts`: one loader, one
 * `refresh`, no polling, `loading` derived rather than set inside the effect.
 *
 * It is a separate read from git status on purpose. A conflicted repository is
 * a state that **survives a page reload** — someone can pull, conflict, close
 * the tab, and come back — so the panel has to be able to discover it without
 * having been the thing that caused it.
 */
import { useCallback, useEffect, useState } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { getGitConflicts, type GitConflictState } from '@site/studio/gitSyncRequests'

export interface GitConflictsState {
  loading: boolean
  error: string | null
  state: GitConflictState | null
  refresh: () => void
}

interface SettledResult {
  key: string
  state: GitConflictState | null
  error: string | null
}

export function useGitConflicts(dir: string | undefined, active: boolean, reloadNonce: number): GitConflictsState {
  const [settled, setSettled] = useState<SettledResult | null>(null)
  const [nonce, setNonce] = useState(0)

  // Referenced from a dep array below, so it needs a stable identity the
  // static exhaustive-deps rule can see (React Compiler exception #1).
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const key = `${dir ?? ''}|${reloadNonce}|${nonce}`

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    getGitConflicts(dir, controller.signal)
      .then((state) => setSettled({ key, state, error: null }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        console.error('[GitPanel] failed to read the conflict state:', err)
        setSettled({ key, state: null, error: getErrorMessage(err, 'Could not read the conflict state') })
      })
    return () => controller.abort()
  }, [dir, active, key])

  return {
    loading: active && settled?.key !== key,
    error: settled?.error ?? null,
    state: settled?.state ?? null,
    refresh,
  }
}
