/**
 * The capture page — the entire application at `/admin/agent-capture`.
 *
 * It fetches one token-authenticated payload, hydrates the editor store with
 * exactly enough of a site document to render, mounts one `CaptureFrame` per
 * requested page, and publishes a readiness report. That is all of it. There
 * is no router, no admin shell, no rail, no panels, no toolbar, no selection,
 * no autosave, no persistence adapter and no live-reload subscription — the
 * things that make the editor an editor are precisely the things a photograph
 * of a screen must not have.
 *
 * ## Why it hydrates the store rather than rendering standalone
 *
 * `NodeRenderer`, `CanvasComposedTree` and every canvas injector read the
 * editor store. That is not incidental coupling to route around: it is what
 * makes this render the SAME pixels the canvas renders. A standalone renderer
 * would be a second implementation of the canvas, and the first time the two
 * disagreed, `studio_compare` would be measuring the difference between two
 * renderers instead of between a screen and its design. So the capture page
 * uses the real store, loaded with a real site document, and simply never
 * mounts anything that can mutate it.
 *
 * ## Why it registers modules through `canvasModuleSet.ts`
 *
 * Same reason. `NodeRenderer` resolves every node through the GLOBAL module
 * registry, so a renderer is only as faithful as the set that was registered
 * before it painted. This page is a separate Vite entry and inherits nothing
 * from the editor's imports — when it kept its own shorter list it rendered
 * `Unknown module: alm.Button` for a page the canvas rendered correctly. It
 * now calls the same entry the editor's `useRegisterProjectModules` calls, and
 * hands the resulting promise to every frame so nothing is photographed before
 * the project's own `pkg.*` components have registered (or been refused).
 *
 * The site shell is built the way `fsCodemodAdapter.loadSite` builds it —
 * `createDefaultSiteDocument` plus the project's pages, style registry,
 * conditions and framework settings. The parts of `loadSite` that are NOT
 * repeated here are its writeback machinery (loaded-value baselines, style
 * rule sources, localized-page watchers, the admin-UI project label): all of
 * it exists to make edits reach disk, and this page cannot edit.
 */
import { useEffect, useState } from 'react'
import { apiRequest } from '@core/http'
import { AGENT_CAPTURE_PAYLOAD_PATH, AgentCapturePayloadSchema, type AgentCapturePayload } from '@core/studio-capture'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { setStudioAuthoredCss, setStudioVendorCss } from '@site/studio/studioRawCssStores'
import { mountCanvasModuleSet } from '@site/studio/canvasModuleSet'
import { CaptureFrame } from './CaptureFrame'
import { createCaptureRun, publishCaptureError, type CaptureRun } from './captureReadiness'
import styles from './CaptureFrame.module.css'

interface CaptureState {
  payload: AgentCapturePayload
  run: CaptureRun
  /** Kicked off with the payload (it needs the project dir), awaited by every frame's settle. */
  moduleRegistration: Promise<void>
}

export function CaptureApp({ token }: { token: string }) {
  const [state, setState] = useState<CaptureState | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const payload = await apiRequest(AGENT_CAPTURE_PAYLOAD_PATH, {
          schema: AgentCapturePayloadSchema,
          query: { token },
        })
        if (cancelled) return
        hydrateCaptureStore(payload)
        // Started BEFORE the frames mount, not awaited here: the built-in
        // packs are already registered (importing `canvasModuleSet` did that),
        // so the frames can paint everything else while the project's own
        // package bundle is still in flight. `CaptureFrame`'s settle is what
        // holds the shutter — bounded, and a warning rather than a refusal if
        // the bundle never arrives.
        setState({
          payload,
          run: createCaptureRun(payload.frames.map((frame) => frame.pageId)),
          moduleRegistration: mountCanvasModuleSet(payload.dir),
        })
      } catch (err) {
        if (cancelled) return
        // The driver reads this verbatim, so it must say what actually broke
        // rather than "capture failed" — a 404 here means an expired grant, a
        // 500 means the project would not parse, and those are different bugs.
        publishCaptureError(getErrorMessage(err, 'The capture payload could not be loaded.'))
      }
    })()
    return () => { cancelled = true }
  }, [token])

  if (!state) return null

  const pageById = new Map(state.payload.pages.map((page) => [page.id, page]))
  return (
    <div className={styles.page}>
      {state.payload.frames.map((frame) => {
        const page = pageById.get(frame.pageId)
        if (!page) return null
        return (
          <CaptureFrame
            key={frame.pageId}
            page={page}
            width={frame.width}
            moduleRegistration={state.moduleRegistration}
            onSettled={state.run.report}
          />
        )
      })}
    </div>
  )
}

/**
 * Put the payload into the editor store and the two module-level CSS stores
 * the canvas injectors read. Called exactly once — this page never reloads a
 * project, so there is no re-entrancy to defend against.
 */
function hydrateCaptureStore(payload: AgentCapturePayload): void {
  setStudioVendorCss(payload.vendorCss)
  setStudioAuthoredCss(payload.authoredCss)

  const site = createDefaultSiteDocument(payload.projectName)
  site.pages = payload.pages
  site.styleRules = payload.styleRules
  site.conditions = payload.conditions
  if (payload.framework) site.settings.framework = payload.framework

  const store = useEditorStore.getState()
  store.loadSite(site)
  if (payload.axes) store.setPreviewAxes(payload.axes)
}
