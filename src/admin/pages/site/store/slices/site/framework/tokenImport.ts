/**
 * applyExtractedFrameworkTokens — store-side landing spot for `tokens-01`'s
 * server-derived Framework tokens (colors/typography/spacing read out of an
 * imported project's own CSS — see `server/handlers/studio/tokenExtract.ts`).
 *
 * The server already performs the "never clobber" merge
 * (`mergeExtractedFramework` — a family is only replaced when it is currently
 * empty) and persists the result to `.studio/framework.json`; this action
 * just lands that ALREADY-MERGED result into the live document so the panel
 * reflects it immediately, without waiting for a full reload. Routed through
 * `mutateSite` (undo-able, same mechanism `setFrameworkPreset` uses) since it
 * can visibly change what's on screen.
 */
import type { SiteSlice, SiteSliceHelpers } from '../types'

type FrameworkTokenImportActions = Pick<SiteSlice, 'applyExtractedFrameworkTokens'>

export function createFrameworkTokenImportActions({
  mutateSite,
}: SiteSliceHelpers): FrameworkTokenImportActions {
  return {
    applyExtractedFrameworkTokens: (framework) => {
      mutateSite((site) => {
        if (JSON.stringify(site.settings.framework) === JSON.stringify(framework)) return false
        site.settings.framework = framework
        return true
      })
    },
  }
}
