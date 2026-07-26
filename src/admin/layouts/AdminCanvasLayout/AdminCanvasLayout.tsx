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
 *   │ [SiteName] [Undo/Redo] [+ Add] ─────── [Zoom] [Save] [Publish] [⚙] [✦] │
 *   ├──────────────────────────── Canvas (full-bleed) ─────────────────────────┤
 *   │  [DOM Tree Panel ▓]     canvas          [Properties Panel ▓]            │
 *   │  position: absolute overlays (z-50)     [AI Panel ▓] (bottom-right)     │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Five independent self-contained floating panels (Guideline #410):
 * - DomPanel (Layers) — top-left
 * - PropertiesPanel — top-right
 * - AgentPanel (AI) — bottom-right, independent visibility
 * - Site explorer panel — site concepts: pages, components, styles, scripts
 * - CodeEditorPanel (Task #432) — center-stage, code editing
 *
 * J12: usePersistence handles CMS draft load on mount, preference-gated
 * auto-save (default 30s; Studio mode overrides to a fixed 2s cadence — see
 * STUDIO_AUTOSAVE_DELAY_MS), toolbar Save, and Cmd+S immediate save.
 *
 * Agent Panel: Phase D AI assistant — self-contained floating panel (Guideline #410).
 * Authenticates via ambient Claude Code credentials through the local Bun server.
 * No env vars, no API keys, no endpoint configuration required (Constraint #385).
 */
import { Toolbar } from '@admin/pages/site/toolbar/Toolbar'
import { ZoomControls } from '@admin/pages/site/toolbar/ZoomControls'
import { PublishButton } from '@admin/pages/site/toolbar/PublishButton'
import { DownloadCodeButton } from '@admin/pages/site/toolbar/DownloadCodeButton'
import { ImportGithubButton } from '@admin/pages/site/toolbar/ImportGithubButton'
import { useEditorAppearancePreferences } from '@admin/pages/site/preferences/editorPreferences'
import { usePersistence } from '@admin/pages/site/hooks/usePersistence'
import { useSiteEditorUrlSync } from '@admin/pages/site/hooks/useSiteEditorUrlSync'
import { useEditorLayoutPersistence } from '@admin/pages/site/hooks/useEditorLayoutPersistence'
import { useEditorStore } from '@admin/pages/site/store/store'
import { cmsAdapter } from '@core/persistence/cms'
import { fsCodemodAdapter, STUDIO_AUTOSAVE_DELAY_MS } from '@site/studio/fsCodemodAdapter'
import { fetchBoards, saveBoards } from '@site/studio/boardsApi'
import { syncStudioModeFromUrl } from '@site/studio/studioMode'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { createBoardsFile } from '@core/studio-board'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAdminUi } from '@admin/state/adminUi'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import {
  CanvasFrameSkeletonFrame,
  DEFAULT_CANVAS_FRAME_SKELETON_BREAKPOINTS,
} from '@admin/shared/CanvasFrameSkeleton'
import { LazyChunkBoundary } from '@admin/lib/LazyChunkBoundary'
import { prewarmedLazy } from '@admin/lib/prewarmedLazy'
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
  hasCapability,
} from '@admin/access'
import { EditorPermissionsProvider } from '@site/EditorPermissionsProvider'
import type { EditorPermissions } from '@site/editorPermissionsContext'

interface AdminCanvasEditorBodyProps {
  canEditDraftSite: boolean
  canSaveSite: boolean
  canUseAiChat: boolean
  loadError: string | null
}

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

// Editor-only toolbar surface: preview iframe. It self-gates on store state,
// but we ALSO conditionally render it at the call site (below) so its chunk
// isn't fetched on first paint — the preview overlay drags in the entire
// publisher graph, which is large.
const PreviewOverlay = lazy(() =>
  import('@admin/pages/site/preview/PreviewOverlay').then((m) => ({
    default: m.PreviewOverlay,
  })),
)

/**
 * AdminCanvasLayout is the Site editor shell. Regular admin pages render
 * through `AdminPageLayout`.
 */
export function AdminCanvasLayout() {
  const site = useEditorStore((s) => s.site)
  // Toolbar branding — pulled from the editor store here (we already have
  // it loaded) and forwarded to the prop-driven Toolbar below. Keeps the
  // Toolbar component itself free of editor-store imports.
  const siteName = useEditorStore((s) => s.site?.name ?? null)
  const faviconUrl = useEditorStore((s) => s.site?.settings.faviconUrl ?? null)
  // Editor-only toolbar surface — gate its lazy chunk on store state.
  const previewOpen = useEditorStore((s) => s.previewOpen)
  // Settings modal mount gate. adminUi is the canonical source — the
  // editor's `settingsSlice.openSettings` mirrors into it, and the admin
  // shell reads from it too.
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
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
  const canPublishPages = !currentUser || hasCapability(currentUser, 'pages.publish')

  const permissions: EditorPermissions = {
    canEditStructure: canEditStructureFlag,
    canEditContent: canEditContentFlag,
    canEditStyle: canEditStyleFlag,
  }
  // J12 — wire persistence: load, auto-save, toolbar Save, Cmd+S.
  // `?studio` opts into the filesystem-as-truth adapter (loads/saves a real
  // .tsx via /admin/api/studio); without it, the normal CMS/DB adapter is used.
  // Resolved once on mount (a lazy initializer, not memoization): it also
  // persists `?studio` intent so a later param-less navigation/refresh doesn't
  // silently drop back to the CMS adapter. See `studioMode.ts`.
  const [studioMode] = useState(() => syncStudioModeFromUrl())
  const persistence = usePersistence('default', studioMode ? fsCodemodAdapter : cmsAdapter, {
    markNewSiteUnsaved: true,
    enabled: true,
    // Studio bypasses the CMS's user-configurable (default 30s) autosave
    // delay in favor of a fixed, snappy cadence — see STUDIO_AUTOSAVE_DELAY_MS.
    autoSaveDelayMs: studioMode ? STUDIO_AUTOSAVE_DELAY_MS : undefined,
  })
  useStudioBoardsPersistence(studioMode)
  useStudioDefaultBoardSeed(studioMode)
  // Keep the open page in lockstep with the URL: consume `?page=<slug>` on
  // load, and mirror the active page's slug back into the address bar so it's
  // directly linkable.
  useSiteEditorUrlSync({
    enabled: true,
    loaded: persistence.saveStatus.state !== 'loading',
  })
  useEditorLayoutPersistence()
  useInstalledEditorPlugins(pluginBackgroundWorkEnabled)
  // Mount the SSE bridge ONCE per admin tab — gives toasts on plugin
  // crashes from any route, drives the red dot on the Plugins nav link,
  // and keeps the open Plugins page list refreshed.
  usePluginEventBridge(pluginBackgroundWorkEnabled)

  // Appearance preferences — data attributes on the editor root drive CSS
  // variables consumed by tree rows, toolbar buttons, text scale, and the
  // admin theme. Reading the preferences here keeps the attributes in sync
  // with Settings without per-component subscriptions.
  //
  // Read BEFORE the `!site` early return so the hook order stays stable across
  // the hydration gate (React rules-of-hooks: hooks must run in the same order
  // on every render).
  const appearance = useEditorAppearancePreferences()

  const loadError = !site && persistence.saveStatus.state === 'error'
    ? persistence.saveStatus.message ?? 'Reload the admin page and try again.'
    : null

  const loadEditorBody = usePostPaintEditorBodyGate()

  return (
    <EditorPermissionsProvider value={permissions}>
      <div
        className={styles.shell}
        data-editor-density={appearance.density}
        data-editor-theme={appearance.theme}
        data-editor-text-scale={appearance.textScale}
      >
        {/* ── Top toolbar (z-60, Guideline #374) ───────────────────────────── */}
        {/* Toolbar is now a prop-driven shell — this layout supplies the
            site brand, the preview overlay lazy mount, and
            the editor-specific right slot (zoom / publish / settings). The
            lazy mount gates on `previewOpen` so the chunk loads only when the
            user actually opens preview. */}
        <Toolbar
          siteName={siteName}
          faviconUrl={faviconUrl}
          section="site"
          overlay={previewOpen && (
            <Suspense fallback={null}>
              <PreviewOverlay />
            </Suspense>
          )}
          rightSlot={(
            <>
              <ZoomControls />
              {/* Publish targets the CMS publish pipeline (static-artefact
                  bake + publish-version bump) — meaningless in Studio, whose
                  source of truth is the on-disk .tsx. Hide the whole action
                  group (Publish + Save draft + status pill) rather than leave
                  a dangling CMS affordance. Studio's own commit-on-idle
                  autosave (STUDIO_AUTOSAVE_DELAY_MS) keeps source in sync
                  without a manual save button; its own export story is
                  DownloadCodeButton below (Phase 6D). */}
              {studioMode ? (
                <>
                  <ImportGithubButton />
                  <DownloadCodeButton />
                </>
              ) : (
                <PublishButton
                  enabled={canPublishPages}
                  onSave={canSaveSite ? persistence.saveSite : undefined}
                  saveStatus={persistence.saveStatus}
                />
              )}
            </>
          )}
        />

        {loadEditorBody ? (
          <LazyChunkBoundary
            location="site-editor-body"
            fallback={<AdminCanvasEditorBodyLoading />}
            resetKeys={[site?.id ?? null]}
            onReset={AdminCanvasEditorBody.reset}
          >
            <AdminCanvasEditorBody
              canEditDraftSite={canEditDraftSite}
              canSaveSite={canSaveSite}
              canUseAiChat={canUseAgent}
              loadError={loadError}
            />
          </LazyChunkBoundary>
        ) : (
          <AdminCanvasEditorBodyLoading />
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
 * Studio-mode sticky-notes board persistence.
 *
 * Load: on mount when `studioMode` is true, and again every time
 * `CMS_SITE_RELOAD_EVENT` fires — fetches `.studio/boards.json` for the
 * ACTIVE workspace dir (`getStudioWorkspaceDir()`; `undefined` = server
 * default) and hydrates `boardSlice` via `loadBoards`. Re-running on the
 * reload event matters for GitHub import (Phase 7B): importing switches the
 * active dir and fires this same event so the page tree reloads
 * (`fsCodemodAdapter`) — boards must follow to the new dir too, or the next
 * auto-save below would silently write board data into the PREVIOUS
 * workspace's `.studio/boards.json`.
 *
 * Auto-save: subscribes to `boardsDirty` and, ~800ms after it flips to `true`,
 * saves the current `boards` back to the server and clears the flag. A ref
 * guards against overlapping saves rather than a full save queue — acceptable
 * for this MVP because a save always reads the latest `boards` at fire time,
 * so a save that starts while another is in flight still lands the freshest
 * state on its own next tick.
 *
 * Entirely inert outside studio mode — the CMS flow never touches this slice.
 */
function useStudioBoardsPersistence(studioMode: boolean): void {
  const savingRef = useRef(false)

  useEffect(() => {
    if (!studioMode) return undefined

    let cancelled = false

    function load() {
      fetchBoards(getStudioWorkspaceDir())
        .then((file) => {
          if (!cancelled) useEditorStore.getState().loadBoards(file)
        })
        .catch((err) => {
          if (cancelled) return
          // A boards-load failure must NOT silently fall the canvas back to the
          // single-page breakpoint frames — in studio the board is the canvas.
          // Seed an empty boards file (loadBoards creates a default board), so
          // the multi-frame board still renders; surface the failure as a toast.
          useEditorStore.getState().loadBoards(createBoardsFile())
          pushToast({
            kind: 'error',
            title: 'Failed to load boards',
            body: getErrorMessage(err, 'Unknown error loading studio boards'),
          })
        })
    }

    load()
    window.addEventListener(CMS_SITE_RELOAD_EVENT, load)

    return () => {
      cancelled = true
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, load)
    }
  }, [studioMode])

  useEffect(() => {
    if (!studioMode) return undefined

    let timer: ReturnType<typeof setTimeout> | undefined

    const runSave = () => {
      if (savingRef.current) return
      savingRef.current = true
      // Snapshot the exact object being persisted. Every board mutation replaces
      // `boards` with a new reference (the pure @core/studio-board transforms are
      // immutable), so identity tells us whether an edit landed mid-flight.
      const snapshot = useEditorStore.getState().boards
      saveBoards(snapshot, getStudioWorkspaceDir())
        .then(() => {
          const st = useEditorStore.getState()
          if (st.boards === snapshot) {
            // Nothing changed during the save — safe to clear the dirty flag.
            st.markBoardsClean()
          } else {
            // Edits arrived while this save was in flight; keep `boardsDirty`
            // set and reschedule so the newer state persists too.
            clearTimeout(timer)
            timer = setTimeout(runSave, BOARDS_AUTOSAVE_DEBOUNCE_MS)
          }
        })
        .catch((err) => {
          pushToast({
            kind: 'error',
            title: 'Failed to save boards',
            body: getErrorMessage(err, 'Unknown error saving studio boards'),
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
  }, [studioMode])
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
 */
function useStudioDefaultBoardSeed(studioMode: boolean): void {
  const boardsLoaded = useEditorStore((s) => s.boardsLoaded)
  const boardCount = useEditorStore((s) => s.boards.boards.length)
  const activeBoard = useEditorStore(selectActiveBoard)
  const activeBoardFrameCount = activeBoard?.frames.length ?? null
  const pageCount = useEditorStore((s) => s.site?.pages.length ?? 0)

  useEffect(() => {
    if (!studioMode) return
    if (!boardsLoaded) return
    if (boardCount !== 1) return
    if (activeBoardFrameCount !== 0) return
    if (pageCount === 0) return

    const sitePages = useEditorStore.getState().site?.pages
    const pageIds = sitePages ? sitePages.map((p) => p.id) : []
    if (pageIds.length === 0) return
    useEditorStore.getState().seedFramesForActiveBoard(pageIds)
  }, [studioMode, boardsLoaded, boardCount, activeBoardFrameCount, pageCount])
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
