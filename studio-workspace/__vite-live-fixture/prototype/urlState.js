// The shell's state in the query string, so a board, a screen, a language and
// a theme are all shareable as a link and survive a reload.

export function getUrlParams() {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const out = {}
  for (const [key, value] of params.entries()) out[key] = value
  return out
}

export function setUrlParams(next) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  for (const key of Object.keys(next)) {
    const value = next[key]
    if (value == null) url.searchParams.delete(key)
    else url.searchParams.set(key, String(value))
  }
  window.history.replaceState(null, '', url)
}
