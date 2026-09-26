/**
 * usePersistence — React hook that wires the Zustand store to the CMS persistence adapter.
 *
 * Responsibilities:
 *  1. LOAD on mount  — loads the single CMS draft site document; falls back to
 *     creating a fresh blank draft when the CMS has no draft yet.
 *  2. AUTO-SAVE      — when enabled in preferences, TRAILING-debounced: the
 *     timer is (re)armed on the `hasUnsavedChanges` false→true transition AND
 *     on every subsequent document mutation, so a typing burst collapses into
 *     a single save at the END of the burst rather than firing `delay` ms
 *     after its first keystroke. `nextAutoSaveDelayMs` caps how long one burst
 *     may defer (see `AUTOSAVE_MAX_DEFERRAL_MULTIPLE`) so continuous editing
 *     cannot starve the save forever. The
 *     delay is the user-configurable CMS preference (default 30 s, see
 *     `readAutoSaveDelayMs`) UNLESS the caller passes `options.autoSaveDelayMs`
 *     — the Site editor shell does this for Studio mode, which has no exposed
 *     autosave-delay setting and instead uses a fixed, snappier cadence
 *     (`STUDIO_AUTOSAVE_DELAY_MS` in `studio/fsCodemodAdapter.ts`) so source
 *     writeback feels immediate. See `resolveAutoSaveDelayMs` in
 *     `autosaveSchedule.ts`.
 *  3. MANUAL SAVE    — returned as a stable callback for toolbar Save and used
 *     by Cmd+S / Ctrl+S. Resets the unsaved-changes flag.
 *  4. RETRY LADDER   — a failed save restores its dirty snapshot (nothing is
 *     lost) and schedules up to three automatic retries on a 2s/4s/8s backoff
 *     through the same single-flight queue, reporting `retrying` on the status
 *     so the toolbar chip can say "Saving…" rather than "Unsaved" while the
 *     ladder runs. No toast at any point — see `SAVE_RETRY_BACKOFF_MS` and
 *     `toolbar/SaveStatusChip.tsx`.
 *  5. FLUSH          — `flushAutosave()` (`autosaveSchedule.ts`, `speed-02`'s
 *     module-size-budget split) asks for the SAME immediate save
 *     `EDITOR_SAVE_REQUEST_EVENT` already triggers (`"Save as layout"`, deep
 *     links), gated on `hasUnsavedChanges` so a stray call with nothing
 *     dirty is a no-op rather than an empty request. Wired into the
 *     properties panel's blur / Enter / scrub-release moments — see
 *     `PropertiesPanel.tsx` — so a field the user visibly finished editing
 *     writes to disk without waiting out even the short trailing debounce
 *     below.
 *
 * Constraint #230: raw adapter data is validated via `validateSite` before
 * being passed to `store.loadSite()`.
 *
 * Mount it once at the top of EditorLayout and pass the returned save callback
 * to toolbar chrome that needs an explicit Save action.
 *
 * Guideline #239 / selector-stability note:
 *   All store reads inside effects use `useEditorStore.getState()` (point-in-time
 *   snapshots) rather than `useEditorStore(selector)` React hooks. This avoids
 *   subscribing EditorLayout to store changes from within this hook, which would
 *   cause spurious re-renders.
 *
 *   The auto-save STATUS subscription uses a primitive boolean selector
 *   `(s) => s.hasUnsavedChanges` so that `Object.is` comparisons work correctly
 *   and the listener fires ONLY when the flag actually changes — not on every
 *   single store update.  Using an inline object selector like
 *   `(s) => ({ site: s.site, dirty: s.hasUnsavedChanges })` would create
 *   a brand-new object on every evaluation, causing the listener to fire on
 *   every store mutation.
 *
 *   The separate `(s) => s.site` subscription is DELIBERATELY per-mutation —
 *   that is the trailing debounce's reschedule signal. It is still a stable
 *   reference selector (Mutative only mints a new document when something
 *   actually changed), and it cannot leak timers: `scheduleAutoSave` clears
 *   the previous timer before arming the next, so at most one is ever live.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { SiteDocument } from '@core/page-tree'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { cmsAdapter } from '@core/persistence/cms'
import { SiteValidationError } from '@core/persistence/validate'
import {
  readAutoSavePreference,
  subscribeToEditorPrefsChanged,
} from '@site/preferences/editorPreferences'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { isAbortError, isUnreachableFailure, retryWhileUnreachable } from '@core/http'
import {
  LOAD_RETRY_BACKOFF_MS,
  SAVE_RETRY_BACKOFF_MS,
  UNREACHABLE_LOAD_MESSAGE,
  type PersistenceController,
  type PersistenceSaveStatus,
} from './persistenceStatus'
import { noteBoardRead } from '@site/studio/sourceIdentity'
import {
  applyDefaultBreakpointPreference,
  applySitePagesPatch,
  applyStructuralWriteOutcome,
  STUDIO_LOAD_COMPLETE_MARK,
  streamedOpenProgress,
} from './siteReloadApply'
import { registerEditorSave } from './editorSaveRef'
import { nextAutoSaveDelayMs, resolveAutoSaveDelayMs } from './autosaveSchedule'

/**
 * Re-exported for back-compat. The canonical declaration lives in
 * `@admin/state/adminEvents` so plugin code (which just dispatches the
 * event after a pack install) can import the constant without dragging
 * this whole hook — and its editor-store dependency — into the
 * non-editor admin bundle.
 */

import {
  CMS_SITE_PAGES_PATCH_EVENT,
  CMS_SITE_RELOAD_EVENT,
  EDITOR_SAVE_REQUEST_EVENT,
  claimCmsSiteReloadRequests,
  consumePendingCmsSiteReload,
  hasPendingCmsSiteReload,
  latestCmsSiteReloadRequest,
  registerCmsSiteReloader,
  type CmsSitePagesPatchDetail,
} from '@admin/state/adminEvents'

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback
}

function currentEditorDataDeepLink(): { table: 'pages' | 'components'; rowId: string } | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const table = params.get('table')
  const rowId = params.get('row')
  if (!rowId) return null
  if (table !== 'pages' && table !== 'components') return null
  return { table, rowId }
}

function siteMissesEditorDataDeepLink(site: SiteDocument): boolean {
  const deepLink = currentEditorDataDeepLink()
  if (!deepLink) return false
  if (deepLink.table === 'pages') {
    return !site.pages.some((page) => page.id === deepLink.rowId)
  }
  return !site.visualComponents.some((component) => component.id === deepLink.rowId)
}

/**
 * ERR-10 — once a reload's document is in the store, apply the structural
 * outcome of every reload request it covers, in request order, and resolve
 * their promises. See `requestCmsSiteReload`.
 */
function settleReloadRequests(covers: number): void {
  const claimed = claimCmsSiteReloadRequests(covers)
  for (const outcome of claimed.structuralOutcomes) applyStructuralWriteOutcome(outcome)
  claimed.settle()
}

/** The save chip right after a load: saved — unless the load carried unsaved edits over (ERR-9). */
function loadedSaveStatus(): PersistenceSaveStatus {
  return useEditorStore.getState().hasUnsavedChanges
    ? { state: 'unsaved', message: 'Unsaved changes' }
    : { state: 'saved', lastSavedAt: Date.now() }
}

export function usePersistence(
  requestedSiteId = 'default',
  adapter: IPersistenceAdapter = cmsAdapter,
  options: { markNewSiteUnsaved?: boolean; enabled?: boolean; autoSaveDelayMs?: number } = {},
): PersistenceController {
  const markNewSiteUnsaved = options.markNewSiteUnsaved ?? false
  const enabled = options.enabled ?? true
  const autoSaveDelayMsOverride = options.autoSaveDelayMs
  const [saveStatus, setSaveStatus] = useState<PersistenceSaveStatus>(
    enabled ? { state: 'loading' } : { state: 'saved' },
  )
  /** ERR-18 — bumped by `retryLoad` to run the initial load again. */
  const [loadAttempt, setLoadAttempt] = useState(0)
  /** ERR-18 — see `PersistenceController.boardStale`. */
  const [boardStale, setBoardStale] = useState(false)
  /** Whether the initial load has completed — prevents auto-save before load */
  const loadedRef = useRef(false)
  /** Stable reference to the adapter so it doesn't trigger re-renders */
  const adapterRef = useRef(adapter)
  useEffect(() => {
    adapterRef.current = adapter
  }, [adapter])

  /** The save currently on the wire, if any. */
  const inFlightSaveRef = useRef<Promise<void> | null>(null)
  /** The single queued follow-up save every mid-flight trigger coalesces into. */
  const queuedSaveRef = useRef<Promise<void> | null>(null)
  /** Consecutive failed saves; reset by the first success. Drives the ladder. */
  const consecutiveFailuresRef = useRef(0)
  /** The armed automatic retry, so a success (or unmount) can cancel it. */
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * Indirection so `runSave`'s failure path can re-enter the single-flight
   * queue without `runSave` depending on `saveCurrentSite`, which depends on
   * it. A retry MUST go through the queue — firing `runSave` directly would
   * be the one place two saves could interleave on the wire.
   */
  const saveCurrentSiteRef = useRef<(() => Promise<void>) | null>(null)

  // Exception #1: referenced in the useCallback dep array of saveCurrentSite,
  // so exhaustive-deps requires a stable identity here.
  const runSave = useCallback(async () => {
    const { site, setHasUnsavedChanges, takeDirtySaveSnapshot, restoreDirtySaveSnapshot } =
      useEditorStore.getState()
    if (!site) return

    setSaveStatus({ state: 'saving', message: 'Saving draft' })
    // Snapshot-and-reset the dirty marks BEFORE the await: edits landing while
    // the save is in flight accumulate fresh marks for the NEXT save, and a
    // failed save merges this snapshot back so nothing is lost.
    const dirty = takeDirtySaveSnapshot()
    try {
      await adapterRef.current.saveSite(site, { dirty })
      // Clear the unsaved flag ONLY when no mutation landed while the save
      // was on the wire — every store mutation produces a new `site`
      // reference, so reference equality is the exact signal. Without this
      // guard a mid-flight edit would lose its "unsaved" status (and the
      // queued follow-up save would be skipped, dropping the edit until the
      // next mutation re-set the flag).
      if (useEditorStore.getState().site === site) setHasUnsavedChanges(false)
      // The ladder is per failure streak, not per session: one success means
      // whatever was wrong has cleared, and the next failure starts at 2s.
      consecutiveFailuresRef.current = 0
      clearTimeout(retryTimerRef.current)
      setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
    } catch (err) {
      restoreDirtySaveSnapshot(dirty)
      // The retry ladder. Silent by design — the toolbar chip renders
      // `retrying`, and a toast per failed attempt is exactly the noise a
      // restarting dev server used to produce.
      consecutiveFailuresRef.current += 1
      const failures = consecutiveFailuresRef.current
      const retrying = failures <= SAVE_RETRY_BACKOFF_MS.length
      setSaveStatus({ state: 'error', message: errorMessage(err, 'Save failed'), retrying })
      if (retrying) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => {
          void saveCurrentSiteRef.current?.().catch((retryErr) => {
            console.error('[persistence] Automatic save retry failed:', retryErr)
          })
        }, SAVE_RETRY_BACKOFF_MS[failures - 1])
      }
      throw err
    }
  }, [])

  /**
   * SINGLE-FLIGHT save queue: at most one save on the wire and at most one
   * queued follow-up. Every trigger (autosave, Cmd+S, save-request events,
   * the MCP bridge, unmount flush) funnels through here, so two saves can
   * never interleave — the failure mode the four-request protocol used to
   * have. A queued save reads the LATEST store state when it runs, so N
   * triggers during one in-flight save collapse into a single follow-up; it
   * is skipped entirely when the in-flight save already shipped everything
   * (no unsaved changes remain).
   *
   * Exception #1: referenced in useEffect dep arrays below, so
   * exhaustive-deps requires a stable identity here.
   */
  const saveCurrentSite = useCallback((): Promise<void> => {
    const start = (): Promise<void> => {
      const run = runSave().finally(() => {
        if (inFlightSaveRef.current === run) inFlightSaveRef.current = null
      })
      inFlightSaveRef.current = run
      return run
    }

    const inFlight = inFlightSaveRef.current
    if (!inFlight) return start()

    queuedSaveRef.current ??= inFlight
      // A failed in-flight save must not cancel the queued retry — its dirty
      // marks were restored, so the follow-up ships them again.
      .catch(() => {})
      .then(() => {
        queuedSaveRef.current = null
        // The in-flight save may have already shipped everything (trigger
        // spam without new edits) — skip the pointless follow-up.
        if (!useEditorStore.getState().hasUnsavedChanges) return
        return start()
      })
    return queuedSaveRef.current
  }, [runSave])

  // Expose the save to the MCP editor-bridge so a write tool relayed from an
  // external agent can flush to the DB before a follow-up headless read.
  useEffect(() => registerEditorSave(saveCurrentSite), [saveCurrentSite])

  // The retry ladder's re-entry point.
  useEffect(() => {
    saveCurrentSiteRef.current = saveCurrentSite
  }, [saveCurrentSite])

  // Unmount only: an armed retry must not fire into an unmounted editor.
  // Deliberately NOT keyed on `saveCurrentSite` — that would cancel a live
  // ladder rung on an identity change rather than on a real teardown.
  useEffect(() => () => {
    saveCurrentSiteRef.current = null
    clearTimeout(retryTimerRef.current)
  }, [])

  // ─── 1. Load site document on mount ────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      loadedRef.current = true
      return
    }

    let cancelled = false
    // Superseding a load (unmount, React's dev double-mount) stops its request too.
    const controller = new AbortController()

    async function load() {
      // Read actions point-in-time — no React subscription needed
      const {
        site: existingSite,
        hasUnsavedChanges,
        loadSite,
        createSite,
        setHasUnsavedChanges,
      } = useEditorStore.getState()

      const pendingCmsSiteReload = hasPendingCmsSiteReload()
      const shouldReloadExistingSite = existingSite
        ? pendingCmsSiteReload || siteMissesEditorDataDeepLink(existingSite)
        : false

      if (existingSite && !shouldReloadExistingSite) {
        loadedRef.current = true
        setSaveStatus(
          hasUnsavedChanges
            ? { state: 'unsaved', message: 'Unsaved changes' }
            : { state: 'saved', lastSavedAt: Date.now() },
        )
        return
      }

      const idToTry = requestedSiteId || 'default'
      // ERR-10 — any reload requested before this fetch starts is answered by it.
      const covers = latestCmsSiteReloadRequest()

      if (idToTry) {
        // P6-B — a first open paints each page as it arrives; a re-read of a
        // document already on screen replaces it whole, as before.
        const streamed = existingSite ? null : streamedOpenProgress(() => !cancelled, () => { loadedRef.current = true })
        try {
          // The adapter validates internally (validateSite + validatePages).
          // Constraint #230 is satisfied at the adapter boundary.
          // ERR-18 — a load that got no answer is tried again on
          // `LOAD_RETRY_BACKOFF_MS`, and the load-error state says so
          // (`retrying`) instead of declaring the project unopenable.
          const site = await retryWhileUnreachable(
            () => {
              if (cancelled) throw new DOMException('Load superseded', 'AbortError')
              return adapterRef.current.loadSite(idToTry, { signal: controller.signal, progress: streamed?.progress })
            },
            {
              backoffMs: LOAD_RETRY_BACKOFF_MS,
              onRetry: () => {
                if (!cancelled) setSaveStatus({ state: 'error', message: UNREACHABLE_LOAD_MESSAGE, retrying: true })
              },
            },
          )
          if (site && !cancelled) {
            if (pendingCmsSiteReload) consumePendingCmsSiteReload()
            if (streamed?.opened()) {
              useEditorStore.getState().finishStreamedLoad(site.pages.map((page) => page.id))
            } else {
              loadSite(site)
              noteBoardRead(site.pages, 'reset') // P1-A — who every source position names, as just read
              applyDefaultBreakpointPreference(site.breakpoints)
            }
            settleReloadRequests(covers)
            loadedRef.current = true
            setBoardStale(false)
            setSaveStatus(loadedSaveStatus())
            performance.mark(STUDIO_LOAD_COMPLETE_MARK)
            return
          }
        } catch (err) {
          if (streamed?.opened() && !cancelled) useEditorStore.getState().abandonStreamedLoad()
          if (cancelled || isAbortError(err)) return
          if (err instanceof SiteValidationError) {
            console.warn('[persistence] Corrupt CMS site data:', err.message)
          } else {
            console.warn('[persistence] Failed to load CMS site:', err)
          }
          setSaveStatus({
            state: 'error',
            message: isUnreachableFailure(err) ? UNREACHABLE_LOAD_MESSAGE : errorMessage(err, 'Failed to load CMS site'),
            retrying: false,
          })
          return
        }
      }

      if (cancelled) return
      if (pendingCmsSiteReload) consumePendingCmsSiteReload()

      if (existingSite) {
        loadedRef.current = true
        setSaveStatus(
          hasUnsavedChanges
            ? { state: 'unsaved', message: 'Unsaved changes' }
            : { state: 'saved', lastSavedAt: Date.now() },
        )
        return
      }

      // Bootstrap a fresh draft once for new installs that have an admin/site row
      // but no studio document yet.
      if (!cancelled) {
        const created = createSite('My Site')
        applyDefaultBreakpointPreference(created.breakpoints)
        loadedRef.current = true
        try {
          // Replace-mode full save (no dirty hints): the site doesn't exist
          // in storage yet.
          await adapterRef.current.saveSite(created)
          // Storage now matches the store — drop the createSite all-dirty mark.
          useEditorStore.getState().takeDirtySaveSnapshot()
          setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
        } catch (err) {
          setHasUnsavedChanges(true)
          setSaveStatus({
            state: markNewSiteUnsaved ? 'unsaved' : 'error',
            message: errorMessage(err, 'Draft not saved yet'),
          })
        }
      }
    }

    load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled, markNewSiteUnsaved, requestedSiteId, loadAttempt])

  // ERR-18 — the Retry button: the whole load again, from a clean "loading".
  // Exception #1: returned to the layout, which passes it down as a click
  // handler; a stable identity keeps the error state from re-rendering.
  const retryLoad = useCallback(() => {
    setSaveStatus({ state: 'loading' })
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  // External "site changed at the server" hook. Non-editor workspaces call
  // `requestCmsSiteReload()`, which retains the reload if this hook is not
  // mounted yet and dispatches `CMS_SITE_RELOAD_EVENT` for live editor mounts.
  //
  // ERR-10 — two rules keep a burst of reloads honest:
  //   1. A monotonic token. Each `reload()` takes the next one when it starts;
  //      when its fetch resolves, it applies only if no later reload has
  //      started since. Two fetches can resolve in either order, and applying
  //      the older one last put the board back to a document from before the
  //      newer write. A superseded response is dropped — the newer reload
  //      covers every request this one did (see rule 2).
  //   2. Requests are settled by the reload that covers them. The reload
  //      records `latestCmsSiteReloadRequest()` before it fetches, and once
  //      its document is in the store it applies the structural outcome of
  //      every request up to that number, in order, and resolves their
  //      promises. That is what makes `requestCmsSiteReload()` awaitable, and
  //      what lets `resyncBoardAfterWrite` hold the structural queue until the
  //      board has actually caught up.
  const reloadTokenRef = useRef(0)
  useEffect(() => {
    if (!enabled) return undefined

    async function reload() {
      const token = ++reloadTokenRef.current
      const covers = latestCmsSiteReloadRequest()
      const idToTry = requestedSiteId || 'default'
      const pendingCmsSiteReload = hasPendingCmsSiteReload()
      let settledEarly = false
      try {
        // Adapter validates internally (Constraint #230). ERR-18 — a re-read
        // that got no answer is tried again on `LOAD_RETRY_BACKOFF_MS`; the
        // requests it covers are settled at the FIRST miss, so a structural
        // queue waiting on this re-read never stalls behind the ladder.
        const site = await retryWhileUnreachable(
          () => {
            if (token !== reloadTokenRef.current) throw new DOMException('Reload superseded', 'AbortError')
            return adapterRef.current.loadSite(idToTry)
          },
          {
            backoffMs: LOAD_RETRY_BACKOFF_MS,
            onRetry: () => {
              if (settledEarly) return
              settledEarly = true
              settleReloadRequests(covers)
            },
          },
        )
        if (token !== reloadTokenRef.current) return
        if (!site) {
          if (pendingCmsSiteReload) consumePendingCmsSiteReload()
          settleReloadRequests(covers)
          return
        }
        // `loadSite` owns the unsaved flag: clear, unless it carried the user's
        // unsaved edits onto the document just read (ERR-9) — those still have
        // to be written, and clearing the flag here would strand them.
        useEditorStore.getState().loadSite(site)
        noteBoardRead(site.pages, 'reset') // P1-A — see `sourceIdentity.ts`
        applyDefaultBreakpointPreference(site.breakpoints)
        if (!settledEarly) settleReloadRequests(covers)
        if (pendingCmsSiteReload) consumePendingCmsSiteReload()
        setBoardStale(false)
        setSaveStatus(loadedSaveStatus())
      } catch (err) {
        // A failure a newer reload has already overtaken is not the board's
        // state any more; that reload reports its own outcome.
        if (token !== reloadTokenRef.current || isAbortError(err)) return
        // Nothing waiting on this reload is left hanging: the queue behind a
        // structural write must not stall on a board that could not catch up.
        if (!settledEarly) settleReloadRequests(covers)
        // The write already landed on disk — this is the board failing to
        // catch up with it, after its retries. ERR-18 — marked quietly on
        // the save chip ("Out of date — reload"), which is also the one-click
        // way back; never a red card over the canvas.
        console.error('[persistence] Reload after a source write failed:', err)
        setBoardStale(true)
      }
    }

    function handleReload() {
      void reload()
    }

    const unregisterReloader = registerCmsSiteReloader()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, handleReload)
    return () => {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, handleReload)
      unregisterReloader()
    }
  }, [enabled, requestedSiteId])

  // Track C5 — the targeted-reload counterpart to the full reload above.
  // `commitStructural`'s narrow path already fetched the replacement pages
  // (via the SAME `?pageIds=` filter the MCP live-reload bridge uses) before
  // dispatching this event; this listener's only job is to hand them to the
  // store. Deliberately NOT retained like `requestCmsSiteReload`'s pending
  // flag — see `CMS_SITE_PAGES_PATCH_EVENT`'s own doc for why a stale patch
  // has nothing honest to replay against a not-yet-mounted editor.
  useEffect(() => {
    if (!enabled) return undefined

    function handlePagesPatch(evt: Event) {
      applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    }

    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, handlePagesPatch)
    return () => window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, handlePagesPatch)
  }, [enabled])

  // ─── 2. Auto-save (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return undefined

    // Primitive boolean selector — Object.is works correctly, listener fires
    // ONLY when hasUnsavedChanges actually changes (false→true or true→false).
    // This avoids creating a new object on every selector evaluation (which
    // would cause the listener to run on every store mutation — timer leak).
    let timer: ReturnType<typeof setTimeout> | undefined
    /** When the current dirty burst started deferring — the `nextAutoSaveDelayMs` budget clock. `null` between bursts. */
    let burstStartedAt: number | null = null

    function scheduleAutoSave() {
      clearTimeout(timer)
      if (!loadedRef.current) return
      if (!useEditorStore.getState().hasUnsavedChanges) return
      if (!readAutoSavePreference()) return

      // Read the delay each time auto-save is scheduled — toggling the
      // preference re-fires `subscribeToEditorPrefsChanged` which calls back
      // into this scheduler, so the next scheduled tick uses the fresh value.
      // `autoSaveDelayMsOverride` (Studio) always wins over the preference.
      const idleDelayMs = resolveAutoSaveDelayMs(autoSaveDelayMsOverride)
      if (burstStartedAt === null) burstStartedAt = Date.now()
      timer = setTimeout(() => {
        burstStartedAt = null
        void saveCurrentSite().catch((err) => {
          console.error('[persistence] Auto-save failed:', err)
        })
      }, nextAutoSaveDelayMs(idleDelayMs, Date.now() - burstStartedAt))
    }

    const unsub = useEditorStore.subscribe(
      (s) => s.hasUnsavedChanges,
      (dirty) => {
        if (!dirty) {
          clearTimeout(timer)
          burstStartedAt = null
          setSaveStatus((status) =>
            status.state === 'saving' ? status : { state: 'saved', lastSavedAt: status.lastSavedAt }
          )
          return
        }
        setSaveStatus({ state: 'unsaved', message: 'Unsaved changes' })
        scheduleAutoSave()
      },
    )
    // The dirty subscription above only fires on the false→true TRANSITION, so
    // on its own it made this a LEADING debounce: the save landed `delay` ms
    // after the FIRST keystroke of a burst, mid-typing — the opposite of the
    // "rapid edits collapse into a single save" behaviour the timer reset was
    // written for. `site` is the honest per-edit signal (Mutative mints a new
    // document object on every mutation that actually changes something, and
    // ONLY then), so rescheduling from it makes this a real trailing debounce.
    // `scheduleAutoSave` re-checks `hasUnsavedChanges` itself, so a `site`
    // write that isn't a user edit (a load, a post-save reload) is a no-op.
    const editUnsub = useEditorStore.subscribe((s) => s.site, scheduleAutoSave)
    const prefsUnsub = subscribeToEditorPrefsChanged(scheduleAutoSave)

    // beforeunload flush — tab close / hard reload. Fire-and-forget: the
    // handler cannot await async work, so this bypasses the save queue and
    // ships the current netted marks WITHOUT resetting them (a failed flush
    // is retried by the next save). One request now, so either the whole
    // save lands or none of it does — no partial-prefix commits at unload.
    function flushBeforeUnload() {
      const { site, hasUnsavedChanges, peekDirtySaveSnapshot } = useEditorStore.getState()
      if (!site || !loadedRef.current || !hasUnsavedChanges) return
      clearTimeout(timer)
      void adapterRef.current
        .saveSite(site, { dirty: peekDirtySaveSnapshot() })
        .catch((err) => {
          console.error('[persistence] flush save failed:', err)
        })
    }

    window.addEventListener('beforeunload', flushBeforeUnload)

    return () => {
      unsub()
      editUnsub()
      prefsUnsub()
      clearTimeout(timer)
      window.removeEventListener('beforeunload', flushBeforeUnload)
      // Unmount cleanup — in-app SPA navigation AWAY from the editor (e.g. to
      // the Data view), which does NOT fire `beforeunload`. Unlike unload,
      // the promise survives unmount, so this routes through the save queue
      // and can never interleave with an in-flight autosave.
      const { site, hasUnsavedChanges } = useEditorStore.getState()
      if (site && loadedRef.current && hasUnsavedChanges) {
        void saveCurrentSite().catch((err) => {
          console.error('[persistence] flush save failed:', err)
        })
      }
    }
  }, [enabled, saveCurrentSite, autoSaveDelayMsOverride])

  // ─── Immediate-save requests ───────────────────────────────────────────────
  // Deliberate, discrete save actions (e.g. "Save as layout") dispatch
  // EDITOR_SAVE_REQUEST_EVENT to commit right away instead of waiting for the
  // autosave debounce. Runs the same pipeline as Cmd+S (snapshot dirty marks,
  // reset the unsaved flag), independent of the autosave preference.
  useEffect(() => {
    if (!enabled) return undefined

    function handleSaveRequest() {
      void saveCurrentSite().catch((err) => {
        console.error('[persistence] Save request failed:', err)
      })
    }

    window.addEventListener(EDITOR_SAVE_REQUEST_EVENT, handleSaveRequest)
    return () => window.removeEventListener(EDITOR_SAVE_REQUEST_EVENT, handleSaveRequest)
  }, [enabled, saveCurrentSite])

  // ─── 3. Cmd/Ctrl+S — immediate save ───────────────────────────────────────
  // Match predicate comes from the keybindings registry — single source of truth.
  useEffect(() => {
    if (!enabled) return undefined

    const kbSave = getKeybindingForCommand('editor.save')

    async function handleKeyDown(e: KeyboardEvent) {
      if (!kbSave?.match(e)) return
      e.preventDefault()

      try {
        await saveCurrentSite()
      } catch (err) {
        console.error('[persistence] Manual save failed:', err)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, saveCurrentSite])

  return { saveSite: saveCurrentSite, saveStatus, retryLoad, boardStale }
}
