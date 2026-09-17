/**
 * useGitBranches — the branch dropdown's data.
 *
 * Same shape as `useGitStatus.ts` and for the same reasons: one loader, one
 * `refresh`, no polling, and `loading` DERIVED from "the current request key
 * has no answer yet" rather than set at the top of the effect (a synchronous
 * `setState` in an effect body is what `react-hooks/set-state-in-effect`
 * rejects, and it forces a second render before the fetch has started).
 *
 * `reloadNonce` lets the panel re-read after anything that can change the
 * ref list — a create, a switch, a fetch, a pull — without this hook needing
 * to know which of those happened.
 *
 * A repository with no branches yet (freshly `init`ed, no commit) answers with
 * an empty list, which is a normal state and not an error.
 */
import { useCallback, useEffect, useState } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { getGitBranches, type GitBranchList } from '@site/studio/gitRequests'

export interface GitBranchesState {
  loading: boolean
  error: string | null
  list: GitBranchList | null
  refresh: () => void
}

interface SettledResult {
  key: string
  list: GitBranchList | null
  error: string | null
}

export function useGitBranches(dir: string | undefined, active: boolean, reloadNonce: number): GitBranchesState {
  const [settled, setSettled] = useState<SettledResult | null>(null)
  const [nonce, setNonce] = useState(0)

  // Referenced from a dep array below, so it needs a stable identity the
  // static exhaustive-deps rule can see (React Compiler exception #1).
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const key = `${dir ?? ''}|${reloadNonce}|${nonce}`

  useEffect(() => {
    // Listing refs spawns a subprocess; a hidden-but-mounted panel must not.
    if (!active) return
    const controller = new AbortController()
    getGitBranches(dir, controller.signal)
      .then((list) => setSettled({ key, list, error: null }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        console.error('[GitPanel] failed to list branches:', err)
        setSettled({ key, list: null, error: getErrorMessage(err, 'Could not list branches') })
      })
    return () => controller.abort()
  }, [dir, active, key])

  return {
    loading: active && settled?.key !== key,
    error: settled?.error ?? null,
    // Kept across a refresh on purpose — the dropdown should not blank out.
    list: settled?.list ?? null,
    refresh,
  }
}
