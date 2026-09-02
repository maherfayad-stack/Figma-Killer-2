import type { StyleRule } from '@core/page-tree'
import { collectSiteStyleBackgroundImagePaths } from '@core/publisher'

type SiteStyleBackgroundPathsCollector = (site: { styleRules: Record<string, StyleRule> }) => Set<string>

/**
 * Single-slot identity memo for the SITE-WIDE background-image path scan
 * `ClassStyleInjector.tsx` needs, mirroring `createCanvasClassCssMemo`
 * (`canvasClassCss.ts`) but keyed on `classes` ALONE. Lives in its own file
 * (not `ClassStyleInjector.tsx`) because that file exports the injector
 * component — Fast Refresh requires a component-only file to export only
 * components, same reason `canvasClassCss.ts` is a sibling file rather than
 * living inside the injector. The factory shape (injectable `collect`)
 * matches that module's own reason too: tests inject a counting collector;
 * runtime code uses the bound `registryBackgroundImagePaths` singleton
 * below.
 *
 * `collectSiteStyleBackgroundImagePaths` (`@core/publisher`) iterates every
 * style rule in the project. It is a shared, stateless primitive — the
 * publisher also calls it server-side during publish (`siteCssBundle.ts`,
 * `mediaPrefetch.ts`), so it must stay pure and MUST NOT be memoized there;
 * a module-level cache in a server module would leak one site's result into
 * another's request.
 *
 * On the canvas, this ran directly in `ClassStyleInjector`'s render body,
 * recomputed every time EITHER `classes` (the registry) OR
 * `previewClassStyles` (one class's live as-you-drag/as-you-type edit)
 * changed — but `previewClassStyles` only ever describes ONE class's
 * in-flight value; it never changes which paths the OTHER rules in the
 * registry reference. `previewClassStyles` changes on every keystroke in the
 * CSS composer and, worse, on every native `pointermove` while scrubbing a
 * value (`ScrubInput.tsx`), and `ClassStyleInjector` mounts once per
 * breakpoint iframe — so a full O(all style rules) re-scan ran N times per
 * animation frame during a scrub gesture, for a result that had not
 * actually changed.
 *
 * Caching on `classes` identity alone (Mutative gives every real edit a new
 * object reference) makes the scan re-run only when the registry itself
 * changes, and lets frames 2..N reuse the same cached `Set` within one
 * commit, exactly like `generateCanvasClassCSS` already does for the
 * generated CSS string.
 */
export function createRegistryBackgroundImagePathsMemo(
  collect: SiteStyleBackgroundPathsCollector = collectSiteStyleBackgroundImagePaths,
): (classes: Record<string, StyleRule>) => Set<string> {
  let cachedClasses: Record<string, StyleRule> | null = null
  let cachedPaths: Set<string> = new Set()
  return (classes) => {
    if (cachedClasses !== classes) {
      cachedClasses = classes
      cachedPaths = collect({ styleRules: classes })
    }
    return cachedPaths
  }
}

/** Runtime singleton — see `createRegistryBackgroundImagePathsMemo`'s doc. */
export const registryBackgroundImagePaths: (classes: Record<string, StyleRule>) => Set<string> =
  createRegistryBackgroundImagePathsMemo()
