/**
 * assetsPrefs — everything the Assets panel remembers between visits, in the
 * two places those memories actually live:
 *
 *   - **Recent inserts** — `localStorage`, per browser. A recency list is a
 *     convenience, not data: losing it costs nothing and syncing it to the
 *     server would cost a round trip on every insert.
 *   - **Notch favourites** — the user preference API, per account. These are
 *     an authored shelf (`CanvasNotch`'s favourites bar reads them) and must
 *     follow the user across machines, so they are server state with a live
 *     external store in front of them.
 *
 * Both key items by `recentKey` (`<kind>:<id>`) so one ref shape addresses a
 * module, a saved layout, or a Visual Component everywhere.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Type, type Static } from '@sinclair/typebox'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import {
  DEFAULT_MODULE_INSERTER_PREFERENCE,
  getUserPreference,
  setUserPreference,
} from '@core/persistence/userPreferences'
import { ApiError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { dedupeAssetRefs, recentKey, type AssetItemRef } from './assetsModel'

/**
 * New key rather than the inserter's `studio-module-inserter-v1`: that blob
 * also carried the deleted dialog's grid/list `view`, and its schema is
 * `additionalProperties: false`, so reading it back would drop to defaults
 * anyway. A recency list is disposable by design.
 */
export const ASSET_PREFS_STORAGE_KEY = 'studio-assets-v1'

const MAX_RECENT_INSERTIONS = 12

const RecentKindSchema = Type.Union([
  Type.Literal('module'),
  Type.Literal('savedLayout'),
  Type.Literal('component'),
])

const RecentRefSchema = Type.Object({
  kind: RecentKindSchema,
  id: Type.String(),
})

const AssetPrefsSchema = Type.Object({
  recent: Type.Array(RecentRefSchema, { maxItems: 32 }),
}, { additionalProperties: false })

type AssetPrefs = Static<typeof AssetPrefsSchema>
const DEFAULT_PREFS: AssetPrefs = { recent: [] }

export function readAssetPrefs(): AssetPrefs {
  try {
    return parseJsonWithFallback(
      localStorage.getItem(ASSET_PREFS_STORAGE_KEY),
      AssetPrefsSchema,
      DEFAULT_PREFS,
    )
  } catch {
    return DEFAULT_PREFS
  }
}

/** Records an insert so the Assets panel can offer it again at the top. */
export function trackAssetInsert(ref: AssetItemRef): void {
  const prefs = readAssetPrefs()
  const key = recentKey(ref)
  const recent = [
    ref,
    ...prefs.recent.filter((existing) => recentKey(existing) !== key),
  ].slice(0, MAX_RECENT_INSERTIONS)

  writeAssetPrefs({ recent })
}

function writeAssetPrefs(prefs: AssetPrefs): void {
  try {
    localStorage.setItem(ASSET_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch (err) {
    console.warn('[assets] Failed to persist preferences:', err)
  }
}

// ---------------------------------------------------------------------------
// Notch favourites — server-persisted, live external store
// ---------------------------------------------------------------------------

interface AssetFavoritesApi {
  favorites: AssetItemRef[]
  loading: boolean
  error: string | null
  isFavorite: (ref: AssetItemRef) => boolean
  toggleFavorite: (ref: AssetItemRef) => void
  setFavorites: (refs: readonly AssetItemRef[]) => void
}

interface AssetFavoritesSnapshot {
  favorites: AssetItemRef[]
  loading: boolean
  error: string | null
}

const DEFAULT_FAVORITES = DEFAULT_MODULE_INSERTER_PREFERENCE.favorites

const listeners = new Set<() => void>()
let snapshot: AssetFavoritesSnapshot = initialSnapshot()
let loadPromise: Promise<void> | null = null
let mutationVersion = 0

/** A new write's version; only the newest write's answer may land. */
function nextMutationVersion(): number {
  mutationVersion += 1
  return mutationVersion
}

export function useAssetFavorites(): AssetFavoritesApi {
  const current = useSyncExternalStore(
    subscribeAssetFavorites,
    getAssetFavoritesSnapshot,
    getAssetFavoritesSnapshot,
  )

  useEffect(() => {
    ensureAssetFavoritesLoaded()
  }, [])

  function saveFavorites(nextFavorites: readonly AssetItemRef[]) {
    const next = dedupeAssetRefs(nextFavorites)
    const saveVersion = nextMutationVersion()
    setSnapshot({ favorites: next, loading: false, error: null })

    void setUserPreference('module-inserter', { favorites: next })
      .then((saved) => {
        if (saveVersion !== mutationVersion) return
        setSnapshot({
          favorites: dedupeAssetRefs(saved.favorites),
          loading: false,
          error: null,
        })
      })
      .catch((err) => {
        if (saveVersion !== mutationVersion) return
        const message = getErrorMessage(err, 'Failed to save asset favourites')
        console.error('[assets] failed to save user preference:', err)
        setSnapshot({ ...snapshot, loading: false, error: message })
      })
  }

  function isFavorite(ref: AssetItemRef): boolean {
    const key = recentKey(ref)
    return current.favorites.some((favorite) => recentKey(favorite) === key)
  }

  function toggleFavorite(ref: AssetItemRef): void {
    const key = recentKey(ref)
    const existing = current.favorites.some((favorite) => recentKey(favorite) === key)
    saveFavorites(
      existing
        ? current.favorites.filter((favorite) => recentKey(favorite) !== key)
        : [...current.favorites, ref],
    )
  }

  return {
    favorites: current.favorites,
    loading: current.loading,
    error: current.error,
    isFavorite,
    toggleFavorite,
    setFavorites: saveFavorites,
  }
}

function initialSnapshot(): AssetFavoritesSnapshot {
  return {
    favorites: [...DEFAULT_FAVORITES],
    loading: true,
    error: null,
  }
}

function subscribeAssetFavorites(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getAssetFavoritesSnapshot(): AssetFavoritesSnapshot {
  return snapshot
}

function setSnapshot(next: AssetFavoritesSnapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}

function ensureAssetFavoritesLoaded() {
  if (loadPromise) return

  const loadMutationVersion = mutationVersion
  loadPromise = (async () => {
    try {
      const stored = await getUserPreference('module-inserter')
      if (mutationVersion !== loadMutationVersion) {
        setSnapshot({ ...snapshot, loading: false })
        return
      }
      setSnapshot({
        favorites: stored ? dedupeAssetRefs(stored.favorites) : [...DEFAULT_FAVORITES],
        loading: false,
        error: null,
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSnapshot({
          favorites: [...DEFAULT_FAVORITES],
          loading: false,
          error: null,
        })
        return
      }
      const message = getErrorMessage(err, 'Failed to load asset favourites')
      console.error('[assets] failed to load user preference:', err)
      setSnapshot({
        ...snapshot,
        loading: false,
        error: mutationVersion === loadMutationVersion ? message : snapshot.error,
      })
    }
  })()
}

export function __resetAssetFavoritesForTests() {
  listeners.clear()
  snapshot = initialSnapshot()
  loadPromise = null
  mutationVersion = 0
}
