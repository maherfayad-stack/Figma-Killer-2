/**
 * useGitPullRequestContext — "can this project have a pull request opened from
 * it, and what would it compare?"
 *
 * Same shape as the panel's other loaders (`useGitStatus`, `useGitBranches`,
 * `useGitConflicts`): one loader, one `refresh`, no polling, `loading` derived
 * rather than set inside the effect.
 *
 * It exists as its own read — rather than the panel inferring the answer from
 * the branch list and the remote URL — so that no browser code ever parses a
 * git remote, and so the compare link is available *before* anything is
 * attempted. That is what lets a refusal ("sign in to GitHub") still hand the
 * user a working link instead of a dead end.
 *
 * `{ supported: false }` is a normal answer (no origin, or an origin that is
 * not GitHub) and is never an error.
 */
import { useCallback, useEffect, useState } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { getGitPullRequestContext, type GitPullRequestContext } from '@site/studio/gitSyncRequests'

export interface GitPullRequestContextState {
  loading: boolean
  error: string | null
  context: GitPullRequestContext | null
  refresh: () => void
}

interface SettledResult {
  key: string
  context: GitPullRequestContext | null
  error: string | null
}

export function useGitPullRequestContext(
  dir: string | undefined,
  active: boolean,
  reloadNonce: number,
): GitPullRequestContextState {
  const [settled, setSettled] = useState<SettledResult | null>(null)
  const [nonce, setNonce] = useState(0)

  // Referenced from a dep array below, so it needs a stable identity the
  // static exhaustive-deps rule can see (React Compiler exception #1).
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const key = `${dir ?? ''}|${reloadNonce}|${nonce}`

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    getGitPullRequestContext(dir, controller.signal)
      .then((context) => setSettled({ key, context, error: null }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        console.error('[GitPanel] failed to read the pull-request context:', err)
        setSettled({ key, context: null, error: getErrorMessage(err, 'Could not read the pull-request context') })
      })
    return () => controller.abort()
  }, [dir, active, key])

  return {
    loading: active && settled?.key !== key,
    error: settled?.error ?? null,
    context: settled?.context ?? null,
    refresh,
  }
}
