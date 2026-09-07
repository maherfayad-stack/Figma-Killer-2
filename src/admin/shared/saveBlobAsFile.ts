/**
 * saveBlobAsFile — hand bytes the admin already holds to the browser's own
 * download machinery.
 *
 * There is exactly one correct way to do this from a page, and it is fiddly
 * enough that every copy of it drifted: mint an object URL, click a hidden
 * anchor, remove the anchor, and revoke the URL AFTER the click has been
 * serviced (revoking synchronously cancels the download in Safari). Three
 * call sites had their own copy — the workspace zip, the agent's image
 * previews, and now the inspector's Export section — so it lives here once.
 *
 * Deliberately NOT a fetch helper: the caller owns how the bytes were
 * obtained (`apiBlobRequest`, a canvas, a `Blob` built in memory) and what
 * the file should be called. This is only the browser hand-off.
 */

/** Milliseconds to keep the object URL alive after the click, so the browser can service the download. */
const REVOKE_DELAY_MS = 1_000

/** Start a native browser download of `blob`; the browser owns the final save location. */
export function saveBlobAsFile(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS)
  }
}
