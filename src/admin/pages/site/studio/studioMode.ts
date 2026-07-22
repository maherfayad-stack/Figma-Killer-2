/**
 * studioMode — the single source of truth for "is the editor in Studio
 * (filesystem-as-truth) mode?".
 *
 * Studio mode is entered with `?studio` (or `?studio=1`) in the URL and left
 * with `?studio=0`. Because it selects a different persistence adapter and a
 * different canvas (the multi-frame board vs. CMS breakpoint frames), it must
 * NOT silently revert when an in-app navigation or a refresh lands on a
 * param-less `/admin/site` — that was the "why did it go back to responsive
 * frames?" bug. So the intent is also persisted to localStorage: once you
 * enter studio, you stay in studio until you explicitly leave with `?studio=0`.
 *
 * `isStudioMode()` is a pure read used by every gate (persistence adapter,
 * module-inserter palette, in-place inspector) so they can never disagree.
 * `syncStudioModeFromUrl()` is called once on editor mount to persist the URL
 * intent; everything else just reads.
 */
const STUDIO_STORAGE_KEY = 'instatic:studio'

/** True when the URL's `studio` value means "on" (present, and not `0`/`false`). */
function urlStudioValue(): boolean | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (!params.has('studio')) return null
  const value = params.get('studio')
  return value !== '0' && value !== 'false'
}

/**
 * Is studio mode active right now? The URL param is authoritative when present
 * (so a shared `?studio=1` / `?studio=0` link always wins); otherwise the
 * persisted sticky flag decides, so a param-less navigation/refresh keeps
 * whatever mode you were in.
 */
export function isStudioMode(): boolean {
  const fromUrl = urlStudioValue()
  if (fromUrl !== null) return fromUrl
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STUDIO_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Persist the URL's studio intent so it survives a later param-less
 * navigation/refresh. Call once on editor mount. Only writes when the URL
 * actually carries a `studio` param (entering with `?studio` sets the flag;
 * `?studio=0` clears it); a param-less load leaves the stored flag untouched.
 * Returns the resolved mode for convenience.
 */
export function syncStudioModeFromUrl(): boolean {
  const on = isStudioMode()
  const fromUrl = urlStudioValue()
  if (fromUrl !== null && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STUDIO_STORAGE_KEY, fromUrl ? '1' : '0')
    } catch {
      // localStorage unavailable (private mode / disabled) — studio still works
      // for this session via the live URL read; it just won't stick.
    }
  }
  return on
}
