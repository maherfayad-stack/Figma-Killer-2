/**
 * canvasModuleSet — the ONE definition of "which modules must be registered
 * before a Studio page can be rendered", for every surface that renders one.
 *
 * There are two such surfaces and they are not the same program:
 *
 *   - the editor canvas (`AdminCanvasEditorBody.tsx` → `CanvasRoot`), and
 *   - the headless capture page (`src/admin/agentCapture/`), a SEPARATE Vite
 *     entry (`agent-capture.html`) that deliberately boots none of the admin
 *     shell — which is exactly why it cannot inherit the editor's imports.
 *
 * They used to declare their module sets independently, and they diverged:
 * the capture entry imported `@modules/base` only, so a page using the
 * design-system pack came back as a PNG full of dashed
 * `Unknown module: alm.Button` boxes while the same page rendered correctly on
 * the canvas one tab over, and a page using a project's own npm design system
 * (`pkg.*`) came back full of package placeholders because
 * `useRegisterProjectModules` was mounted by the editor and by nothing else.
 * A screenshot that silently disagrees with the canvas is worse than no
 * screenshot: every downstream visual-audit tool (`studio_compare`,
 * `studio_diff_frames`, the PNG export, project thumbnails) treats it as
 * evidence.
 *
 * So the set lives here, once, and both callers go through this file:
 *
 *   1. **Built-in packs**, imported for their registration side effect — the
 *      module registry is a global singleton and `NodeRenderer` resolves every
 *      node through it. Importing this module registers them; there is no
 *      "forgot to call it" state.
 *   2. **The project's own package components** (`pkg.*`), which are per-project
 *      and asynchronous — `registerProjectPackageModules(dir)`, backed by the
 *      Tier-1 component bundle. The TRUST GATE for those is the server route's
 *      (`componentBundle.ts` refuses at Tier 0 before parsing or bundling
 *      anything), so neither caller re-implements it and neither can get it
 *      wrong: at Tier 0 the capture renders precisely the placeholder the
 *      editor renders at Tier 0.
 *
 * Adding a pack to the canvas means adding one line HERE. That is the whole
 * point of the file.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import {
  projectPackageModulesSettled,
  registerProjectPackageModules,
} from './registerProjectModules'
import { getStudioTrustTier, subscribeStudioTrustTier } from './studioProjectTrust'

// ── The built-in packs ─────────────────────────────────────────────────────
// Side-effect imports: each module self-registers with the global registry.
// `@modules/base` also pulls in `@modules/studio/slot` (see its own index).
import '@modules/base'
import '@modules/alm/register'
// Loop data sources — a `base.loop` node renders nothing without them, and a
// captured page with a loop in it must not be a picture of an empty div.
import '@core/loops/sources'

export { projectPackageModulesSettled }

/**
 * Register the project-scoped half of the set for `projectDir`, and hand back
 * the in-flight registration.
 *
 * The one-shot renderer's entry (`CaptureApp`): it has a `dir` from its own
 * payload and no `adminUi` store to read one from, and it must be able to WAIT
 * for the answer before it photographs anything.
 */
export function mountCanvasModuleSet(projectDir: string | null): Promise<void> {
  return registerProjectPackageModules(projectDir)
}

/**
 * The editor's entry — mounted once from `AdminCanvasEditorBody.tsx`.
 *
 * Same set, driven by the two things that change it in a live session: the
 * open project (`adminUi.studioProject.dir`) and the trust tier (a successful
 * "promote" action — `promoteProjectToTier1` in `studioProjectTrust.ts` —
 * updates the external store this subscribes to, so promoting mid-session
 * picks up components without a page reload).
 *
 * The returned promise is deliberately dropped here: the canvas subscribes to
 * `registry.subscribe` (`NodeRenderer.tsx`) and re-renders whenever a module
 * arrives, however late. Only a surface that renders exactly once needs to
 * await it.
 */
export function useRegisterProjectModules(): void {
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)

  useEffect(() => {
    void mountCanvasModuleSet(projectDir)
  }, [projectDir, trust])
}
