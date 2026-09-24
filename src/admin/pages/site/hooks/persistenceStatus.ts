/**
 * persistenceStatus — what `usePersistence` reports, and the retry ladders it
 * runs on. Split out of `usePersistence.ts` (module-size ceiling) because the
 * status vocabulary and the ladder timings are read on their own — the save
 * chip renders the status, tests pin the ladders — without the hook.
 */

export interface PersistenceSaveStatus {
  state: 'loading' | 'saved' | 'unsaved' | 'saving' | 'error'
  message?: string
  lastSavedAt?: number
  /**
   * Only meaningful for `state: 'error'` — true while the automatic retry
   * ladder (see `SAVE_RETRY_BACKOFF_MS`) still has a rung left. The toolbar's
   * save-status chip reads "Saving…" while it is true and only admits
   * "Unsaved — retry" once it is false, so a dev server that takes six
   * seconds to come back never makes the editor claim work was lost.
   */
  retrying?: boolean
}

/**
 * Delays before automatic save retry 1, 2 and 3; the length is the budget.
 *
 * A save fails for two reasons in practice — the dev server is restarting, or
 * the target file is momentarily locked — and both usually clear inside ten
 * seconds. Past three attempts the failure is not transient and the user has
 * to be told, which is what "Unsaved — retry" is for. The ladder lives here
 * rather than in the chip because retrying a save is the persistence layer's
 * job: it already owns the single-flight queue and the dirty snapshot that a
 * retry re-ships.
 */
export const SAVE_RETRY_BACKOFF_MS = [2000, 4000, 8000] as const

/**
 * ERR-18 — delays before automatic LOAD retry 1, 2 and 3 (the project open and
 * every background re-read). Same ladder, same reason as the save's: a server
 * restarting during open, or a network blip, clears inside ten seconds, and
 * the board should simply arrive rather than show "Could not open this
 * project" for a failure that was never the project's. Only a failure that
 * got NO answer is retried (`isUnreachableFailure`); a real answer (a parse
 * failure, a missing folder) is shown at once, with a Retry button.
 */
export const LOAD_RETRY_BACKOFF_MS = [2000, 4000, 8000] as const

/** What the load-error state says while (and after) the server gave no answer at all — never a raw `TypeError`. */
export const UNREACHABLE_LOAD_MESSAGE = 'Studio could not reach the server to read this project.'

export interface PersistenceController {
  saveSite: () => Promise<void>
  saveStatus: PersistenceSaveStatus
  /**
   * ERR-18 — load the project again, from the start. The Retry button on the
   * "Could not open this project" state, for a failure the ladder could not
   * ride out.
   */
  retryLoad: () => void
  /**
   * ERR-18 — true when the last background re-read (after a write, an agent
   * push, an outside edit) failed even after its retries, so the board may be
   * showing an older version of the files than disk has. Rendered quietly by
   * the save chip ("Out of date — reload"), never as a toast. Cleared by the
   * next successful read.
   */
  boardStale: boolean
}
