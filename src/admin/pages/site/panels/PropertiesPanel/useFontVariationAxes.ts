/**
 * useFontVariationAxes — resolves the Typography settings popover's Variable
 * tab axis list (F27) for a `fontFamily` value.
 *
 * Real network + binary work: it finds the ONE `FontFile` format this
 * codebase can read axes from today (`findProbableVariableFontFile` —
 * uncompressed `.ttf`/`.otf` only, see its doc for why), fetches its bytes
 * through `apiBlobRequest` (the sanctioned binary-GET primitive — see
 * `@core/http`'s doc; a raw `fetch()` here would trip
 * `boundary-validation.test.ts`'s admin-fetch rule), and parses its `fvar`
 * table with `@core/fonts`'s `parseFontVariationAxes`.
 *
 * The "no candidate file" and "already cached" cases are answered directly
 * from render — no effect, no setState — so the effect body only ever calls
 * `setState` from inside the fetch's own `.then`/`.catch` callback (the
 * async-update shape `react-hooks/set-state-in-effect` expects), never
 * synchronously at the top of the effect.
 *
 * Deliberately thin glue over two already-tested pure functions, so it
 * carries no test of its own — `TypographySettings`'s tests drive the
 * RESULT (a `variationAxes` prop) directly instead of mocking a network
 * fetch to exercise this hook end to end.
 */
import { useEffect, useState } from 'react'
import { apiBlobRequest } from '@core/http'
import {
  findProbableVariableFontFile,
  parseFontVariationAxes,
  type FontVariationAxis,
  type SiteFontsSettings,
} from '@core/fonts'
import { resolveFontEntryForFamily } from './fontWeightOptions'

/** Keyed by file path (not family name) — two families sharing a re-uploaded file would otherwise re-fetch needlessly. Module-level: the parsed axis set for a given font file never changes within a session. */
const axisCacheByPath = new Map<string, ReadonlyArray<FontVariationAxis>>()

/** The most recently fetched (or failed) axis set, tagged with the cache key it answers — read from render only when it matches the CURRENT key. */
interface FetchedAxes {
  key: string
  axes: ReadonlyArray<FontVariationAxis>
}

export function useFontVariationAxes(
  fontFamilyValue: unknown,
  fonts: SiteFontsSettings | null,
): ReadonlyArray<FontVariationAxis> {
  const entry = resolveFontEntryForFamily(fontFamilyValue, fonts)
  const file = entry ? findProbableVariableFontFile(entry) : undefined
  const cacheKey = file?.path

  const [fetched, setFetched] = useState<FetchedAxes | null>(null)

  useEffect(() => {
    // Nothing to fetch (no ttf/otf candidate), or already answered by a
    // prior mount for this exact file — both are derivable at render time
    // below, so the effect has nothing to do.
    if (!cacheKey || !file || axisCacheByPath.has(cacheKey)) return
    let cancelled = false
    apiBlobRequest(file.path)
      .then((blob) => blob.arrayBuffer())
      .then((buffer) => {
        if (cancelled) return
        const parsed = parseFontVariationAxes(new Uint8Array(buffer))
        axisCacheByPath.set(cacheKey, parsed)
        setFetched({ key: cacheKey, axes: parsed })
      })
      .catch(() => {
        // Can't tell whether the font is variable — the honest answer is
        // "no axes", never a guess.
        if (cancelled) return
        axisCacheByPath.set(cacheKey, [])
        setFetched({ key: cacheKey, axes: [] })
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, file])

  if (!cacheKey) return []
  const cached = axisCacheByPath.get(cacheKey)
  if (cached) return cached
  if (fetched && fetched.key === cacheKey) return fetched.axes
  return []
}
