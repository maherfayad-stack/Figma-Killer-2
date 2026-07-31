// Reflects the app's demo state (page, language, theme, and the various
// state/style toggles) into the URL query string so it's shareable/bookmarkable
// and survives a page reload.

export function getUrlParam(key) {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(key)
}

export function setUrlParams(params) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  Object.entries(params).forEach(([key, value]) => {
    if (value == null) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  })
  window.history.replaceState(null, '', url)
}
