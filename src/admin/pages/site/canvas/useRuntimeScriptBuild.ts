/**
 * useRuntimeScriptBuild — owns the bundled runtime scripts injected into the
 * editable canvas iframes when the "Run scripts" toggle is on.
 *
 * Unlike the old preview surface (which built a full static HTML document and
 * dropped it into a sandboxed `srcDoc` iframe), the editable canvas frames are
 * React-rendered, same-origin iframes. So we don't want a whole document — we
 * only want the runtime script contents, which we inject as inline
 * `<script>` tags alongside the live node tree with the configured loader
 * format (see
 * `RuntimeScriptInjector`).
 *
 * Build trigger contract:
 * - Enabled only while the "Run scripts" toggle is on (`enabled`).
 * - Rebuilds when the script bundle's inputs change — the page being viewed,
 *   the active breakpoint, the template context, and anything that affects the
 *   bundle (`site.files` / `site.runtime` / `site.packageJson`). Crucially it
 *   does NOT rebuild on ordinary node-tree edits: those don't touch the script
 *   inputs, so the bundle signature stays stable and scripts are not re-run on
 *   every keystroke.
 * - Also rebuilds on an explicit Refresh (the user's escape hatch for when a
 *   React reconcile clobbered script-mutated DOM).
 *
 * The 350ms debounce coalesces rapid edits (e.g. agent tool batches).
 *
 * Perf (Track C3 / audit 06 E9)
 * ──────────────────────────────
 * This used to subscribe to the WHOLE `s.site` object and call
 * `computeBuildSignature` (a `JSON.stringify` of three of its fields) in the
 * render body on every render that subscription triggered. `site`'s top-level
 * reference changes on every site-touching mutation anywhere in the document,
 * so the signature (and its `JSON.stringify`) was recomputed on every
 * keystroke, in every mounted frame, regardless of whether `files`/`runtime`/
 * `packageJson` had actually changed. It now selects those three fields
 * directly — each is structurally-shared-stable across edits to node content
 * (Mutative only recreates the branch of the tree actually touched) — so
 * `computeBuildSignature` only re-runs when one of them, or the page/
 * breakpoint/template inputs, genuinely changed.
 */

import { useEffect, useEffectEvent, useState } from 'react'
import type { Page } from '@core/page-tree'
import type { SiteFile } from '@core/files/schemas'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useEditorStore } from '@site/store/store'
import {
  buildCmsRuntimePreview,
  type CmsRuntimePreviewResult,
} from '@core/persistence/cmsRuntime'
import type { SiteRuntimeConfig, SiteRuntimeDiagnostic, SiteScriptFormat, SiteScriptPlacement } from '@core/site-runtime'
import { getErrorMessage } from '@core/utils/errorMessage'

/** Stable empty fallback for the files selector (Guideline #239). */
const EMPTY_FILES: SiteFile[] = []

export type RuntimeScriptStatus = 'idle' | 'building' | 'ready' | 'error'

/**
 * One runtime entry ready to inject inline. Module entries are bundled and
 * self-contained; classic entries are raw browser-global scripts.
 */
export interface InjectableRuntimeScript {
  id: string
  format: SiteScriptFormat
  placement: SiteScriptPlacement
  content: string
}

interface RuntimeScriptBuildState {
  /** Bundled scripts to inject, ordered by priority. Empty until first build. */
  scripts: InjectableRuntimeScript[]
  /** Build lifecycle status. */
  status: RuntimeScriptStatus
  /** Diagnostics surfaced by the server build (esbuild errors, etc.). */
  diagnostics: SiteRuntimeDiagnostic[]
  /** Force a rebuild + re-run from current site state. */
  refresh: () => void
}

interface UseRuntimeScriptBuildArgs {
  page: Page | null
  breakpointId: string
  templateContext?: TemplateRenderDataContext
  /** Gates the effect — pass `false` when the "Run scripts" toggle is off. */
  enabled: boolean
  /** Defaults to the production debounce; tests pass 0 to avoid real-time waits. */
  debounceMs?: number
}

interface BuildResult {
  signature: string
  scripts: InjectableRuntimeScript[]
  diagnostics: SiteRuntimeDiagnostic[]
  status: 'ready' | 'error'
}

/**
 * Map a completed preview build into the inline-injectable entry scripts.
 * `runtimeAssets.scripts` is already priority-ordered; each entry's `src`
 * matches an asset's `publicPath`, whose `content` is the standalone bundle.
 */
function extractInjectableScripts(result: CmsRuntimePreviewResult): InjectableRuntimeScript[] {
  const assetByPublicPath = new Map(result.assets.map((asset) => [asset.publicPath, asset]))
  return result.runtimeAssets.scripts
    .map((script) => {
      const asset = assetByPublicPath.get(script.src)
      if (!asset) return null
      return {
        id: script.fileId,
        format: script.format ?? 'module',
        placement: script.placement,
        content: asset.content,
      }
    })
    .filter((entry): entry is InjectableRuntimeScript => entry !== null)
}

function computeBuildSignature(
  hasSite: boolean,
  files: SiteFile[],
  runtime: SiteRuntimeConfig | null,
  packageJson: SitePackageJson | null,
  pageId: string | null,
  breakpointId: string,
  templateContext: TemplateRenderDataContext | undefined,
): string | null {
  if (!hasSite || !pageId) return null
  // Key on the bundle's actual inputs (script files, runtime config, deps)
  // rather than `site.updatedAt`, so editing the node tree — which leaves
  // these untouched — does NOT re-run scripts. Editing a script file or a
  // dependency rotates the signature and triggers a fresh bundle.
  return JSON.stringify({
    files,
    runtime,
    packageJson,
    pageId,
    breakpointId,
    templateContext: templateContext ?? null,
  })
}

export function useRuntimeScriptBuild({
  page,
  breakpointId,
  templateContext,
  enabled,
  debounceMs = 350,
}: UseRuntimeScriptBuildArgs): RuntimeScriptBuildState {
  // Narrow slices — see the module doc's "Perf (Track C3)" section. Each is
  // reference-stable across an edit to node content anywhere on the board.
  const hasSite = useEditorStore((s) => s.site !== null)
  const files = useEditorStore((s) => s.site?.files ?? EMPTY_FILES)
  const runtime = useEditorStore((s) => s.site?.runtime ?? null)
  const packageJson = useEditorStore((s) => s.site?.packageJson ?? null)
  const [build, setBuild] = useState<BuildResult | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const buildSignature = computeBuildSignature(
    hasSite,
    files,
    runtime,
    packageJson,
    page?.id ?? null,
    breakpointId,
    templateContext,
  )

  const isIdle = !enabled || !hasSite || !page || buildSignature === null

  const kickOffBuild = useEffectEvent(() => {
    if (page === null || buildSignature === null) return null
    const pageId = page.id
    const capturedBreakpointId = breakpointId
    const capturedTemplateContext = templateContext
    const capturedSignature = buildSignature

    let cancelled = false

    const timeout = window.setTimeout(() => {
      const currentSite = useEditorStore.getState().site
      if (!currentSite) return

      buildCmsRuntimePreview({
        site: currentSite,
        pageId,
        breakpointId: capturedBreakpointId,
        templateContext: capturedTemplateContext,
      })
        .then((result) => {
          if (cancelled) return
          setBuild({
            signature: capturedSignature,
            scripts: extractInjectableScripts(result),
            diagnostics: result.diagnostics,
            status: result.diagnostics.some((d) => d.severity === 'error') ? 'error' : 'ready',
          })
        })
        .catch((error) => {
          if (cancelled) return
          setBuild({
            signature: capturedSignature,
            scripts: [],
            diagnostics: [
              {
                code: 'runtime-script-client-error',
                severity: 'error',
                message: getErrorMessage(error, 'Runtime script build failed'),
              },
            ],
            status: 'error',
          })
        })
    }, debounceMs)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  })

  useEffect(() => {
    if (isIdle || buildSignature === null) return
    return kickOffBuild() ?? undefined
  }, [buildSignature, isIdle, refreshNonce, debounceMs])

  const refresh = () => {
    setRefreshNonce((n) => n + 1)
  }

  const matchesCurrent = build !== null && build.signature === buildSignature
  const status: RuntimeScriptStatus = isIdle
    ? 'idle'
    : matchesCurrent
      ? build.status
      : 'building'
  const scripts = isIdle || !matchesCurrent ? EMPTY_SCRIPTS : build.scripts
  const diagnostics = isIdle || !matchesCurrent ? EMPTY_DIAGNOSTICS : build.diagnostics

  return { scripts, status, diagnostics, refresh }
}

// Stable empty sentinels so the returned arrays keep a constant identity while
// idle/building — prevents downstream effects (the injector) from re-running
// against a fresh `[]` every render.
const EMPTY_SCRIPTS: InjectableRuntimeScript[] = []
const EMPTY_DIAGNOSTICS: SiteRuntimeDiagnostic[] = []
