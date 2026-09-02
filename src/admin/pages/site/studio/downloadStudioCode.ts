/**
 * downloadStudioCode — client for `GET /admin/api/studio/download` (Phase 6D
 * — "Download the code"). Not codegen: the server just zips the workspace's
 * real `.tsx` source, which already exists on disk.
 *
 * Fetches through `apiBlobRequest` (the authenticated binary-response entry
 * in `@core/http`) rather than a raw `fetch` — same credentialed/error-
 * normalized transport `apiRequest` uses, just returning a `Blob`. Per the
 * `apiBlobRequest` contract, the caller is responsible for checking the
 * returned MIME type before treating the bytes as a zip.
 */
import { apiBlobRequest, type FetchLike } from '@core/http'

interface DownloadStudioCodeOptions {
  /** Server default workspace when omitted. */
  dir?: string
  fetchImpl?: FetchLike
}

/** Fetch the workspace source zip and validate its MIME type. Does not save it. */
export async function readStudioCodeZip(options: DownloadStudioCodeOptions = {}): Promise<Blob> {
  const blob = await apiBlobRequest('/admin/api/studio/download', {
    query: options.dir ? { dir: options.dir } : undefined,
    fallbackMessage: 'The workspace code could not be downloaded.',
    fetchImpl: options.fetchImpl,
  })
  const mimeType = blob.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (mimeType !== 'application/zip') {
    throw new Error('The server did not return a zip archive.')
  }
  return blob
}

/** Start a native browser download of the workspace source zip. */
export async function downloadStudioCode(options: DownloadStudioCodeOptions = {}): Promise<void> {
  const blob = await readStudioCodeZip(options)
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = 'studio-workspace.zip'
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  }
}
