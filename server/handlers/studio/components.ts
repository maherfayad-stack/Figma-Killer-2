/**
 * components — `GET /admin/api/studio/components`, Track E1 ("The component
 * catalog") of `STUDIO-FIGMA-PARITY-PLAN.md` §8 — **"do this first; it
 * unblocks three features"**. Nothing in the product could previously answer
 * "what components does this project have, and what props do they take?" —
 * this route is that answer, project-wide, off the SAME `createWorkspaceProject`
 * ts-morph `Project` `componentSources.ts`/`loadStudioPages` already build
 * for the page-parse pipeline. No second parse, no second `Project`.
 *
 *   GET /admin/api/studio/components?dir=<abs>
 *     -> `{ components: LocalComponentSpec[] }` — every exported,
 *        PascalCase-named component declared anywhere in the workspace
 *        (`extractLocalComponentCatalog`, `componentSpecExtract.ts`), sorted
 *        by file then name. A project with no matching files (or no pages
 *        directory at all) yields `{ components: [] }`, never an error.
 *
 * **Not built here — the three features this unblocks, named so the actual
 * integration gap is visible rather than assumed:**
 *   - The Swap picker (`InstanceCallSiteView.tsx`'s `openSwapPicker`), which
 *     today only offers components already instantiated on the LOADED
 *     BOARD. This route answers the identical question against the whole
 *     PROJECT — the picker has to be wired to CALL it.
 *   - Per-prop controls for a `studio.instance`'s call-site props
 *     (`controlForCallSiteValue`), which today guesses a control from the
 *     runtime VALUE's type instead of the component's own declared
 *     `PropKind` this catalog now carries.
 *   - A prop the call site doesn't pass, which today gets no row at all —
 *     this catalog is what tells the panel such a prop EXISTS to add
 *     (`setJsxProp.ts` already supports writing one).
 * None of the three consumers are wired in this change — see this route's
 * own `STATE.md` handoff for what "reachable, but not yet called by the
 * panel" means here, and confirm with a direct `curl` before assuming a
 * consumer already exists.
 *
 * **Parse, never execute.** `extractLocalComponentCatalog` and everything it
 * calls only ever reads the WRITTEN AST — no component renders, no hook
 * runs, no module evaluates. Never throws: an unreadable file, a malformed
 * declaration, or a project with no pages directory all just contribute
 * nothing to the list, same posture as every other `tryServeStudio*`
 * sub-router's Not-Found-on-refusal contract.
 *
 * Same containment posture as every other project-scoped route
 * (`trustTier.ts`, `extractComponent.ts`): `resolveProjectDir` +
 * `isRealpathContained(dir, projectsRootDir())`.
 */
import { createWorkspaceProject } from '@core/page-parser'
import { jsonResponse } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { extractLocalComponentCatalog, type LocalComponentSpec } from './componentSpecExtract'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/components'

/** `GET /admin/api/studio/components` — see module doc for the full contract. */
export async function tryServeStudioComponents(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'GET') return null

  try {
    const dir = resolveProjectDir(url.searchParams.get('dir'))
    if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

    const project = createWorkspaceProject(dir)
    const components: LocalComponentSpec[] = extractLocalComponentCatalog(project, dir)
    return jsonResponse({ components })
  } catch (err) {
    console.error('[studio:components]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
