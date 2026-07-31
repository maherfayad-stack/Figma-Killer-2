/**
 * studioTokenStatus — `tokens-01`'s client-side landing spot for
 * server-derived design-token extraction results (`server/handlers/studio/
 * tokenExtract.ts`'s `POST /admin/api/studio/tokens`).
 *
 * Split out of `fsCodemodAdapter.ts` purely to stay under the module-size-
 * budget ceiling (`module-size-budgets.test.ts`) — this is one coherent,
 * already self-contained concern (a response schema, a tiny external store,
 * and the fetch that refreshes it), not a change of ownership. `loadSite`
 * calls `fetchExtractedTokens` directly (it has no live document yet to
 * apply the result to); `fsCodemodAdapter.refreshExtractedTokens` — the
 * Framework panel's "Re-scan tokens" action — wraps it and additionally
 * pushes the result into the live store, which is why that thin wrapper
 * stays in `fsCodemodAdapter.ts` (it needs `loadedDir`/`lastSyncedFrameworkJson`,
 * both private module state there).
 */
import { apiRequest } from '@core/http'
import { FrameworkSettingsSchema, type FrameworkSettings } from '@core/framework-schema'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * Mirrors `server/handlers/studio/tokenExtract.ts`'s `TokenExtractionSource`/
 * `TokenExtractionCounts`/`ProbeWarning`. Kept as a local mirror rather than a
 * shared import: this file runs in the browser, that one runs in Node/
 * ts-morph, and the two sides only need to agree on the JSON wire shape.
 */
const TokenExtractionSourceSchema = Type.Union([
  Type.Literal('project-css'),
  Type.Literal('tailwind-theme'),
  Type.Literal('vendor-css'),
  Type.Literal('none'),
])
const TokenExtractionCountsSchema = Type.Object({
  colors: Type.Number(),
  spacing: Type.Number(),
  typography: Type.Number(),
})
const TokenExtractionWarningSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  fix: Type.String(),
})

/** POST /admin/api/studio/tokens response. */
const StudioTokensPostResponseSchema = Type.Object({
  ok: Type.Boolean(),
  framework: FrameworkSettingsSchema,
  source: TokenExtractionSourceSchema,
  counts: TokenExtractionCountsSchema,
  warnings: Type.Array(TokenExtractionWarningSchema),
})

export interface TokenExtractionStatus {
  source: Static<typeof TokenExtractionSourceSchema>
  counts: Static<typeof TokenExtractionCountsSchema>
  warnings: Static<typeof TokenExtractionWarningSchema>[]
}

/**
 * What the last token extraction found. Same "tiny external store" shape as
 * `fsCodemodAdapter.ts`'s `vendorCss`/`trustTier`: the Framework panel's
 * status banner needs to know when a fresh result lands without subscribing
 * to `site` itself (whose reference changes on every unrelated node edit).
 * `null` before the first load.
 */
let tokenExtractionStatus: TokenExtractionStatus | null = null
const listeners = new Set<() => void>()

export function getStudioTokenExtractionStatus(): TokenExtractionStatus | null {
  return tokenExtractionStatus
}

export function subscribeStudioTokenExtractionStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Runs (or re-runs) server-side token extraction for `dir` and records the
 * result in the status store above. Does NOT touch the live editor document
 * — `loadSite` has none yet to apply it to, and `fsCodemodAdapter
 * .refreshExtractedTokens` (the "Re-scan tokens" action, which DOES have a
 * live document) applies the returned `framework` itself.
 */
export async function fetchExtractedTokens(
  dir: string,
): Promise<{ framework: FrameworkSettings; status: TokenExtractionStatus }> {
  const { framework, source, counts, warnings } = await apiRequest('/admin/api/studio/tokens', {
    method: 'POST',
    body: { dir },
    schema: StudioTokensPostResponseSchema,
  })
  const status: TokenExtractionStatus = { source, counts, warnings }
  tokenExtractionStatus = status
  for (const listener of listeners) listener()
  return { framework, status }
}
