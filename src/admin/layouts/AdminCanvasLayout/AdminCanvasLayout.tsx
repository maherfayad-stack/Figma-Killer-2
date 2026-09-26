/**
 * AdminCanvasLayout — the Site editor admin shell.
 *
 * One of the admin layout families in `src/admin/layouts/`:
 *   - AdminCanvasLayout (this file) — used by the Site editor. Paints the
 *     real toolbar/chrome first, then lazy-loads the editor body containing
 *     floating panels, page canvas, and Site Explorer's shared DnD context.
 *   - AdminPageLayout — used by Plugins, Users, Account, and plugin admin
 *     pages. Strips the canvas / sidebar / DnD chrome and renders a
 *     simple centered page body with a unified header.
 *
 * Pick AdminCanvasLayout for the visual Site editor; pick AdminPageLayout
 * for a regular admin page that should not download Site-editor-only
 * modules on first paint.
 *
 * Editor Overlay Layout (Guideline #410 — motion-editor style):
 *   ┌─────────────────────────────── Toolbar ──────────────────────────────────┐  z-60
 *   │ [SiteName] [Undo/Redo] [+ Add] ────────── [Zoom] [Studio actions] [⚙] [✦] │
 *   ├──────────────────────────── Canvas (full-bleed) ─────────────────────────┤
 *   │  [DOM Tree Panel ▓]     canvas          [Properties Panel ▓]            │
 *   │  position: absolute overlays (z-50)     [AI Panel ▓] (bottom-right)     │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Five independent self-contained floating panels (Guideline #410):
 * - DomPanel (Layers) — top-left
 * - PropertiesPanel — top-right
 * - AgentPanel (AI) — bottom-right, independent visibility
 * - Explorer panel — Boards + all-pages Layers tree (`StudioExplorer`)
 * - CodeEditorPanel (Task #432) — center-stage, code editing
 *
 * J12: usePersistence loads/saves via `fsCodemodAdapter` (the filesystem-as-
 * truth adapter) on mount, a fixed 2s idle-commit autosave cadence
 * (`STUDIO_AUTOSAVE_DELAY_MS`), and Cmd+S immediate save.
 *
 * Agent Panel: Phase D AI assistant — self-contained floating panel (Guideline #410).
 * Authenticates via ambient Claude Code credentials through the local Bun server.
 * No env vars, no API keys, no endpoint configuration required (Constraint #385).
 */
import { Toolbar } from '@admin/pages/site/toolbar/Toolbar'
import { ZoomControls } from '@admin/pages/site/toolbar/ZoomControls'
import { SaveStatusChip } from '@admin/pages/site/toolbar/SaveStatusChip'
import { useEditorAppearancePreferences } from '@admin/pages/site/preferences/editorPreferences'
import { usePersistence } from '@admin/pages/site/hooks/usePersistence'
import { useSiteEditorUrlSync } from '@admin/pages/site/hooks/useSiteEditorUrlSync'
import { useEditorLayoutPersistence } from '@admin/pages/site/hooks/useEditorLayoutPersistence'
import { useEditorStore } from '@admin/pages/site/store/store'
import { fsCodemodAdapter, STUDIO_AUTOSAVE_DELAY_MS } from '@site/studio/fsCodemodAdapter'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { shouldSeedDefaultBoard } from './studioDefaultBoardSeed'
import { collectFrameIds, shouldRefuseBoardsSave } from './boardsSaveGuard'
import { pushToast } from '@ui/components/Toast'
import { retryWhileUnreachable } from '@core/http'
import { useAdminUi } from '@admin/state/adminUi'
import { CMS_SITE_RELOAD_EVENT, requestCmsSiteReload } from '@admin/state/adminEvents'
import {
  CanvasFrameSkeletonFrame,
  DEFAULT_CANVAS_FRAME_SKELETON_BREAKPOINTS,
} from '@admin/shared/CanvasFrameSkeleton'
import { LazyChunkBoundary } from '@admin/lib/LazyChunkBoundary'
import { ChromeBoundary } from '@site/ui/ChromeBoundary'
import { prewarmedLazy } from '@admin/lib/prewarmedLazy'
import { StudioBoardLayers } from '@site/canvas/studioBoardLayersChunk'
import styles from './AdminCanvasLayout.module.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useCurrentAdminUser } from '@admin/sessionContext'
import {
  canEditContent as accessCanEditContent,
  canEditStructure as accessCanEditStructure,
  canEditStyle as accessCanEditStyle,
  canSaveDraftSite,
  canRunPluginBackgroundWork,
  canUseAiChat,
} from '@admin/access'
import { EditorPermissionsProvider } from '@site/EditorPermissionsProvider'
import type { EditorPermissions } from '@site/editorPermissionsContext'

// A type-only import: the body's props, declared once beside the component,
// without pulling its chunk into this route shell.
import type { AdminCanvasEditorBodyProps } from './AdminCanvasEditorBody'

const AdminCanvasEditorBody = prewarmedLazy<AdminCanvasEditorBodyProps>(
  () =>
    import('./AdminCanvasEditorBody').then((m) => ({ default: m.AdminCanvasEditorBody })),
  { displayName: 'AdminCanvasEditorBody' },
)

// SettingsModal is heavy (~37 KB raw) and closed 99% of the time. lazy()
// pushes it into its own chunk and the conditional render below avoids
// kicking off the dynamic import until the user actually opens settings.
// Once opened, React.lazy() caches the resolved module — subsequent
// open/close cycles are instant.
const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

// Studio toolbar actions. lazy() keeps ImportProjectButton/DownloadCodeButton
// (plus their `downloadStudioCode.ts` client) out of the eager SitePage route
// chunk until the toolbar actually mounts. Bundled behind ONE lazy boundary
// (`StudioToolbarActions`) rather than several, so the SitePage shell only
// pays for a single dynamic-import preload map.
const StudioToolbarActions = lazy(() =>
  import('@admin/pages/site/toolbar/StudioToolbarActions').then((m) => ({
    default: m.StudioToolbarActions,
  })),
)

// Editor-plugin runtime — Studio doesn't consume editor plugins on the
// canvas itself, so it's mounted only while Settings → Plugins is open
// (install/enable/disable can still activate a plugin's editor entrypoint
// there). lazy() + the `pluginRuntimeNeeded` gate below keep a bare mount
// from firing the `GET /admin/api/cms/plugins` round trip and downloading
// the plugin runtime's dependency graph until it's actually needed. See
// `PluginRuntimeBridge.tsx`.
const PluginRuntimeBridge = lazy(() =>
  import('./PluginRuntimeBridge').then((m) => ({ default: m.PluginRuntimeBridge })),
)

/**
 * AdminCanvasLayout is the Site editor shell. Regular admin pages render
 * through `AdminPageLayout`.
 */
export function AdminCanvasLayout() {
  // The document's identity only — never `s.site` itself, which Mutative
  // replaces on every edit and would re-render the whole editor shell on every
  // keystroke (P2-I, PERF-12; gated by `no-full-site-scan-in-selectors.test.ts`).
  const siteId = useEditorStore((s) => s.site?.id ?? null)
  // Toolbar branding — pulled from the editor store here (we already have
  // it loaded) and forwarded to the prop-driven Toolbar below. Keeps the
  // Toolbar component itself free of editor-store imports.
  const siteName = useEditorStore((s) => s.site?.name ?? null)
  const faviconUrl = useEditorStore((s) => s.site?.settings.faviconUrl ?? null)
  // Settings modal mount gate. adminUi is the canonical source — the
  // editor's `settingsSlice.openSettings` mirrors into it, and the admin
  // shell reads from it too.
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
  const settingsSection = useAdminUi((s) => s.settingsSection)
  const publishSiteSummary = useAdminUi((s) => s.setSiteSummary)
  const currentUser = useCurrentAdminUser()
  const pluginBackgroundWorkEnabled = canRunPluginBackgroundWork(currentUser)

  // Keep the adminUi site summary in sync with whatever the editor store
  // currently holds. AdminPageLayout reads siteName / faviconUrl from
  // adminUi (not the editor store), so editor pages need to publish there
  // too. This effect fires whenever the underlying values change, and is
  // cheap because adminUi.setSiteSummary is a stable setter.
  useEffect(() => {
    if (siteName === null) return
    publishSiteSummary({ name: siteName, faviconUrl })
  }, [siteName, faviconUrl, publishSiteSummary])
  // The toolbar's "Open live page" target (adminUi.activeLivePath) is owned by
  // `useActiveLivePath` in the lazy editor body — it resolves templates to the
  // page / post they're previewed against instead of their non-routable slug.
  // Three-way edit permissions — see `src/admin/access.ts`. A user with all
  // three holds full editor rights; a user with only `canEditContent` is the
  // "Client / copy editor" persona: read everything, change copy on existing
  // nodes, no DnD, no style edits, no structural changes.
  const canEditStructureFlag = accessCanEditStructure(currentUser)
  const canEditContentFlag = accessCanEditContent(currentUser)
  const canEditStyleFlag = accessCanEditStyle(currentUser)
  const canSaveSite = canSaveDraftSite(currentUser)
  const canUseAgent = canUseAiChat(currentUser)
  // Legacy "anything-editable" flag — true when the caller can drag/drop and
  // structurally modify the canvas. Most existing call sites are structural
  // by nature (DnD, context menu, rename, delete keyboard shortcut, plugin
  // overlays). Content-only callers still get the canvas in read-mostly mode
  // with content controls live.
  const canEditDraftSite = canEditStructureFlag

  const permissions: EditorPermissions = {
    canEditStructure: canEditStructureFlag,
    canEditContent: canEditContentFlag,
    canEditStyle: canEditStyleFlag,
  }
  // J12 — wire persistence: load, auto-save, toolbar Save, Cmd+S.
  // Studio always loads/saves a real .tsx via the filesystem-as-truth
  // adapter (/admin/api/studio).
  const persistence = usePersistence('default', fsCodemodAdapter, {
    markNewSiteUnsaved: true,
    enabled: true,
    // Studio bypasses the CMS's user-configurable (default 30s) autosave
    // delay in favor of a fixed, snappy cadence — see STUDIO_AUTOSAVE_DELAY_MS
    // (250ms trailing debounce, 1s deferral cap as of speed-02). The
    // properties panel also calls `flushAutosave()` on blur/Enter/scrub-
    // release so a settled field writes to disk before even this window
    // elapses — see `hooks/autosaveSchedule.ts`.
    autoSaveDelayMs: STUDIO_AUTOSAVE_DELAY_MS,
  })
  useStudioBoardsPersistence()
  useStudioDefaultBoardSeed()
  // Keep the open page in lockstep with the URL: consume `?page=<slug>` on
  // load, and mirror the active page's slug back into the address bar so it's
  // directly linkable.
  useSiteEditorUrlSync({
    enabled: true,
    loaded: persistence.saveStatus.state !== 'loading',
  })
  useEditorLayoutPersistence()
  // Studio doesn't use editor plugins on the canvas itself — mount the
  // runtime on demand, while Settings → Plugins is the open section, so
  // install/enable/disable there can still activate a plugin's editor
  // entrypoint. See `PluginRuntimeBridge.tsx`.
  const pluginRuntimeNeeded = settingsOpen && settingsSection === 'plugins'

  // Appearance preferences — data attributes on the editor root drive CSS
  // variables consumed by tree rows, toolbar buttons, text scale, and the
  // admin theme. Reading the preferences here keeps the attributes in sync
  // with Settings without per-component subscriptions.
  //
  // Read BEFORE the `siteId === null` early return so the hook order stays stable across
  // the hydration gate (React rules-of-hooks: hooks must run in the same order
  // on every render).
  const appearance = useEditorAppearancePreferences()

  const loadError = siteId === null && persistence.saveStatus.state === 'error'
    ? persistence.saveStatus.message ?? 'Studio could not read this project.'
    : null
  // ERR-18 — while the load ladder still has a rung left, the load-error state
  // says "trying again" instead of declaring the project unopenable.
  const loadRetrying = loadError !== null && persistence.saveStatus.retrying === true

  const loadEditorBody = usePostPaintEditorBodyGate()
  // P6-B — every project opens on a board, so the board's own chunk is fetched
  // WITH the body rather than after it (`studioBoardLayersChunk.ts`).
  useEffect(() => {
    if (!loadEditorBody) return
    StudioBoardLayers.preload().catch((err: unknown) => {
      // The canvas's own render retries it through its Suspense boundary.
      console.error('[AdminCanvasLayout] board layers preload failed:', err)
    })
  }, [loadEditorBody])

  return (
    <EditorPermissionsProvider value={permissions}>
      <div
        className={styles.shell}
        data-editor-density={appearance.density}
        data-editor-theme={appearance.theme}
        data-editor-text-scale={appearance.textScale}
      >
        {/* ── Top toolbar (z-60, Guideline #374) ───────────────────────────── */}
        {/* Toolbar is a prop-driven shell — this layout supplies the site
            brand and the editor-specific right slot (zoom / publish /
            settings). */}
        {/* ERR-13 — the toolbar sits outside the editor-body boundary, so a
            crash in it used to reach `admin-route` and take the whole editor
            down. It is its own silent seam now. */}
        <ChromeBoundary id="toolbar">
          <Toolbar
            siteName={siteName}
            faviconUrl={faviconUrl}
            section="site"
            rightSlot={(
              <>
                {/* Z6 — the save path is silent on failure by design (it
                    restores the dirty snapshot and retries three times). The
                    chip is the only thing that says so; no toast on this path. */}
                <SaveStatusChip
                  status={persistence.saveStatus}
                  onRetry={persistence.saveSite}
                  boardStale={persistence.boardStale}
                />
                <ZoomControls />
                {/* Studio's source of truth is the on-disk .tsx — there is no
                    CMS publish pipeline to target. Studio's own commit-on-idle
                    autosave (STUDIO_AUTOSAVE_DELAY_MS) keeps source in sync
                    without a manual save button; its export story is
                    DownloadCodeButton (Phase 6D). */}
                <Suspense fallback={null}>
                  <StudioToolbarActions />
                </Suspense>
              </>
            )}
          />
        </ChromeBoundary>

        {loadEditorBody ? (
          <LazyChunkBoundary
            location="site-editor-body"
            fallback={<AdminCanvasEditorBodyLoading />}
            resetKeys={[siteId]}
            onReset={AdminCanvasEditorBody.reset}
          >
            <AdminCanvasEditorBody
              canEditDraftSite={canEditDraftSite}
              canSaveSite={canSaveSite}
              canUseAiChat={canUseAgent}
              loadError={loadError}
              loadRetrying={loadRetrying}
              onRetryLoad={persistence.retryLoad}
            />
          </LazyChunkBoundary>
        ) : (
          <AdminCanvasEditorBodyLoading />
        )}

        {/* Editor-plugin runtime, headless. Mounted on demand while
            Settings → Plugins is open, so install/enable/disable there still
            activates a plugin's editor entrypoint. `enabled` stays the
            capability check the hooks always received. */}
        {pluginRuntimeNeeded && (
          <Suspense fallback={null}>
            <PluginRuntimeBridge enabled={pluginBackgroundWorkEnabled} />
          </Suspense>
        )}

        {/* Settings Modal (portal-rendered, listens to adminUi.settingsOpen).
            Lazy + conditional render — the 1300-line modal + its six section
            subtree stays out of the eager graph until the user opens settings. */}
        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsModal />
          </Suspense>
        )}

      </div>
    </EditorPermissionsProvider>
  )
}

/** Debounce delay before an auto-save fires after a board mutation. */
const BOARDS_AUTOSAVE_DEBOUNCE_MS = 800

/**
 * Studio sticky-notes board persistence.
 *
 * Load: on mount, and again every time `CMS_SITE_RELOAD_EVENT` fires —
 * fetches `.studio/boards.json` for the ACTIVE workspace dir
 * (`getStudioWorkspaceDir()`; `undefined` = server default) and hydrates
 * `boardSlice` via `loadBoards`. Re-running on the reload event matters for
 * GitHub import (Phase 7B): importing switches the active dir and fires
 * this same event so the page tree reloads (`fsCodemodAdapter`) — boards
 * must follow to the new dir too, or the next auto-save below would
 * silently write board data into the PREVIOUS workspace's
 * `.studio/boards.json`.
 *
 * Auto-save: subscribes to `boardsDirty` and, ~800ms after it flips to `true`,
 * saves the current `boards` back to the server and clears the flag. A ref
 * guards against overlapping saves rather than a full save queue — acceptable
 * for this MVP because a save always reads the latest `boards` at fire time,
 * so a save that starts while another is in flight still lands the freshest
 * state on its own next tick.
 */
function useStudioBoardsPersistence(): void {
  const savingRef = useRef(false)
  // The known-good frame-id set as of the last load or save that we KNOW
  // reflects the real on-disk file — the baseline `boardsSaveGuard.ts`
  // compares an outgoing save against. `null` until the first one lands.
  const lastKnownGoodFrameIdsRef = useRef<Set<string> | null>(null)
  // Suppresses toast spam while a refusal keeps recurring — reset the moment
  // a save actually goes through (or a fresh load re-establishes the
  // baseline), so a NEW episode still gets its own toast.
  const warnedAboutRefusalRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    // Store-02's landmine names "a stale project switch" as a way the
    // in-memory `boards` can end up NOT reflecting the real on-disk file: two
    // `load()` calls can be in flight at once (this effect's `load` is
    // invoked again on every `CMS_SITE_RELOAD_EVENT`, e.g. a project switch,
    // without cancelling whatever fetch is already in flight), and network
    // resolution order is not call order. A token guard makes only the MOST
    // RECENTLY STARTED `load()` allowed to write into the store — an older,
    // slower response arriving late is simply dropped instead of overwriting
    // newer, correct state (or worse, a different project's boards).
    let loadToken = 0

    function load() {
      const thisLoadToken = ++loadToken
      const isStale = () => cancelled || thisLoadToken !== loadToken

      // Dynamic import: keeps `boardsApi`'s client out of the eager SitePage
      // route chunk until this effect actually needs it. P3-A — a read that
      // got no answer is tried again quietly before anything is said.
      import('@site/studio/boardsApi')
        .then(({ fetchBoards }) => {
          const dir = getStudioWorkspaceDir()
          return retryWhileUnreachable(() => fetchBoards(dir))
        })
        .then((file) => {
          if (isStale()) return
          useEditorStore.getState().loadBoards(file)
          // A real load — reflects the on-disk file at this instant. New
          // baseline for the save guard; a fresh episode may warn again.
          lastKnownGoodFrameIdsRef.current = collectFrameIds(file)
          warnedAboutRefusalRef.current = false
        })
        .catch((err) => {
          if (isStale()) return
          // A boards-load failure must NOT silently fall the canvas back to the
          // single-page breakpoint frames — in studio the board is the canvas.
          // Render a placeholder empty board so the multi-frame board still
          // renders; surface the failure as a toast. Deliberately NOT
          // `loadBoards(createBoardsFile())` — that marks the synthesized
          // board dirty and indistinguishable from a legitimately-empty new
          // project, which let `useStudioDefaultBoardSeed` seed it from
          // whatever `site.pages` held at that moment and the 800ms
          // autosave then overwrite the REAL (never actually read)
          // boards.json with that reduced set. `markBoardsLoadFailed` keeps
          // this placeholder out of both the seed effect and the autosave
          // until a real load succeeds.
          //
          // P3-A — a warning with its remedy, after the quiet retries above:
          // the pages are fine and nothing was lost; only the frame layout
          // could not be read, and one click reads it again.
          console.error('[AdminCanvasLayout] boards load failed:', err)
          useEditorStore.getState().markBoardsLoadFailed()
          pushToast({
            kind: 'warning',
            title: 'Board layout not loaded',
            body: 'Studio could not read where your frames sit on the board, so they are shown in a default layout. Nothing was changed on disk.',
            action: { label: 'Try again', onSelect: load },
            dedupeKey: 'boards-load-failed',
          })
        })

      // WS-7.2 — the per-project frame default (`.studio/meta.json`'s
      // `frameDefaults`), so a page added THIS session inherits a width set
      // via "apply to all pages" earlier, and every screen in a project
      // created as Mobile/Web opens at that form factor's size.
      //
      // Cleared FIRST: until this project's own answer arrives, the previous
      // project's defaults are not this project's, and the default-board seed
      // (which waits on `frameDefaultsSettled`) must not run on them.
      useEditorStore.getState().clearFrameDefaults()
      import('@site/studio/frameDefaultsApi')
        .then(({ fetchFrameDefaults }) => fetchFrameDefaults(getStudioWorkspaceDir()))
        .then((defaults) => {
          if (!isStale()) useEditorStore.getState().setFrameDefaults(defaults)
        })
        .catch((err) => {
          console.error('[AdminCanvasLayout] frame-defaults load failed:', err)
          // Settled-but-empty, not "still waiting": a failed hydration must
          // unblock the seed (the board still has to render) and fall back to
          // the hardcoded frame size, rather than stall it forever.
          if (!isStale()) useEditorStore.getState().setFrameDefaults({})
        })
    }

    load()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, load)

    return () => {
      cancelled = true
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, load)
    }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const runSave = () => {
      if (savingRef.current) return
      savingRef.current = true
      // Snapshot the exact object being persisted. Every board mutation replaces
      // `boards` with a new reference (the pure @core/studio-board transforms are
      // immutable), so identity tells us whether an edit landed mid-flight.
      const snapshot = useEditorStore.getState().boards

      // Last-line-of-defense content check (see `boardsSaveGuard.ts`): refuse
      // to write a frame set that is missing something the store last
      // confirmed was real, unless a real removal explains the shrink. This
      // NEVER runs a network request when it refuses — a corrupted in-memory
      // state must never reach disk, but it also must not be mistaken for "no
      // pending work", so `boardsDirty` is deliberately left set and the tick
      // rescheduled (cheap — an in-memory comparison, no I/O) rather than
      // silently going quiet for the rest of the session.
      if (
        shouldRefuseBoardsSave({
          baselineFrameIds: lastKnownGoodFrameIdsRef.current,
          nextFrameIds: collectFrameIds(snapshot),
          explicitRemovalPending: useEditorStore.getState().boardsPendingExplicitRemoval,
        })
      ) {
        savingRef.current = false
        if (!warnedAboutRefusalRef.current) {
          warnedAboutRefusalRef.current = true
          console.error(
            '[AdminCanvasLayout] refused to save boards.json: outgoing frame set is missing frames the store last confirmed were real, with no explicit removal to explain it.',
          )
          pushToast({
            kind: 'warning',
            title: 'Boards not saved',
            body: 'The in-memory board layout looks like it lost frames unexpectedly, so the save was skipped to avoid overwriting your boards.json.',
            // ERR-29 — the remedy is one click, not an instruction.
            action: { label: 'Re-read the board', onSelect: () => void requestCmsSiteReload() },
          })
        }
        clearTimeout(timer)
        timer = setTimeout(runSave, BOARDS_AUTOSAVE_DEBOUNCE_MS)
        return
      }

      // P3-A — the whole board document, so saving it twice is harmless:
      // a save that got no answer is tried again quietly.
      import('@site/studio/boardsApi')
        .then(({ saveBoards }) => {
          const dir = getStudioWorkspaceDir()
          return retryWhileUnreachable(() => saveBoards(snapshot, dir))
        })
        .then(() => {
          const st = useEditorStore.getState()
          if (st.boards === snapshot) {
            // Nothing changed during the save — safe to clear the dirty flag.
            st.markBoardsClean()
            // This save's payload is now confirmed on disk — new baseline.
            lastKnownGoodFrameIdsRef.current = collectFrameIds(snapshot)
            warnedAboutRefusalRef.current = false
          } else {
            // Edits arrived while this save was in flight; keep `boardsDirty`
            // set and reschedule so the newer state persists too. The JUST-
            // SAVED snapshot is still real on disk — advance the baseline to
            // it (not to the newer in-memory state, which hasn't saved yet).
            lastKnownGoodFrameIdsRef.current = collectFrameIds(snapshot)
            clearTimeout(timer)
            timer = setTimeout(runSave, BOARDS_AUTOSAVE_DEBOUNCE_MS)
          }
        })
        .catch((err) => {
          // `boardsDirty` stays set, so the layout is still pending; the
          // warning carries the one-click retry.
          console.error('[AdminCanvasLayout] boards save failed:', err)
          pushToast({
            kind: 'warning',
            title: 'Board layout not saved yet',
            body: 'Studio could not write where your frames sit on the board. Your pages are saved; only the layout is pending.',
            action: { label: 'Try again', onSelect: runSave },
            dedupeKey: 'boards-save-failed',
          })
        })
        .finally(() => {
          savingRef.current = false
        })
    }

    const unsubscribe = useEditorStore.subscribe(
      (s) => s.boardsDirty,
      (dirty) => {
        if (!dirty) return
        clearTimeout(timer)
        timer = setTimeout(runSave, BOARDS_AUTOSAVE_DEBOUNCE_MS)
      },
    )

    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])
}

/**
 * One-time default-board seed.
 *
 * `BoardFramesLayer` now renders exactly `board.frames` — an empty board
 * renders an empty-state card, not "every page". That's correct for a
 * NEW board (a 2nd+ board should start blank; the whole point of multiple
 * boards is that each curates its own subset of pages), but it would
 * REGRESS the board a Studio user is already using: before per-board frame
 * membership existed, that board's (empty) `frames` meant "show every
 * page", so today it's showing every page with no saved frames at all.
 *
 * Fix: the very first time the sole/default board is seen with zero frames
 * (and at least one page exists to seed), populate it with a frame for
 * every current page — reproducing the old "show every page" behavior as a
 * real, persisted `board.frames` list. `boards.boards.length === 1` is the
 * signal that distinguishes this from a deliberately-empty 2nd/3rd board a
 * user just created via `addBoard` — those are never auto-seeded, so they
 * stay intentionally blank until the user adds frames themselves.
 *
 * Naturally idempotent, no ref/flag needed: once the seed lands, the active
 * board's `frames.length` is no longer 0, so the condition is false on every
 * subsequent run of this effect for the rest of the session (and boards.json
 * persists it, so it never re-triggers on reload either).
 *
 * Refuses while `boardsLoadFailed` is true — see `shouldSeedDefaultBoard`'s
 * doc (`studioDefaultBoardSeed.ts`) for the `boards-fetch-race-01` regression
 * this guards against.
 */
function useStudioDefaultBoardSeed(): void {
  const boardsLoaded = useEditorStore((s) => s.boardsLoaded)
  const boardsLoadFailed = useEditorStore((s) => s.boardsLoadFailed)
  const boardCount = useEditorStore((s) => s.boards.boards.length)
  const activeBoard = useEditorStore(selectActiveBoard)
  const activeBoardFrameCount = activeBoard?.frames.length ?? null
  const pageCount = useEditorStore((s) => s.site?.pages.length ?? 0)
  const frameDefaultsSettled = useEditorStore((s) => s.frameDefaultsSettled)
  const pagesArriving = useEditorStore((s) => s.pendingPages.length > 0)

  useEffect(() => {
    if (!shouldSeedDefaultBoard({ boardsLoaded, boardsLoadFailed, boardCount, activeBoardFrameCount, pageCount, frameDefaultsSettled, pagesArriving })) return

    const sitePages = useEditorStore.getState().site?.pages
    const pageIds = sitePages ? sitePages.map((p) => p.id) : []
    if (pageIds.length === 0) return
    useEditorStore.getState().seedFramesForActiveBoard(pageIds)
  }, [boardsLoaded, boardsLoadFailed, boardCount, activeBoardFrameCount, pageCount, frameDefaultsSettled, pagesArriving])
}

function usePostPaintEditorBodyGate(): boolean {
  const delayBodyUntilPaint =
    typeof import.meta.env !== 'undefined' && import.meta.env.PROD === true
  const [loadEditorBody, setLoadEditorBody] = useState(!delayBodyUntilPaint)

  useEffect(() => {
    if (!delayBodyUntilPaint) return
    return scheduleAfterFirstPaint(() => setLoadEditorBody(true))
  }, [delayBodyUntilPaint])

  return loadEditorBody
}

function scheduleAfterFirstPaint(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  if (typeof window.requestAnimationFrame !== 'function') {
    const timeoutId = window.setTimeout(callback, 0)
    return () => window.clearTimeout(timeoutId)
  }

  let secondFrameId: number | null = null
  const firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(callback)
  })

  return () => {
    window.cancelAnimationFrame(firstFrameId)
    if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId)
  }
}

function AdminCanvasEditorBodyLoading() {
  return (
    <div className={styles.editorBody} aria-busy="true">
      <div className={styles.canvasStage} data-right-sidebar-expanded="false">
        <div className={styles.canvasContent}>
          <section
            className={styles.canvasBootstrapStatus}
            role="status"
            aria-label="Loading editor"
          >
            <div className={styles.canvasBootstrapLayer} aria-hidden="true">
              {DEFAULT_CANVAS_FRAME_SKELETON_BREAKPOINTS.map((breakpoint) => (
                <CanvasFrameSkeletonFrame
                  key={breakpoint.id}
                  breakpoint={breakpoint}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
