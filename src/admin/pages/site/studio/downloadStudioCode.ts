/**
 * downloadStudioCode — client for `GET /admin/api/studio/download` (Phase 6D
 * — "Download the code"). Not codegen: the server just zips the workspace's
 * real `.tsx` source, which already exists on disk.
 *
 * Fetches through `apiFileRequest` (the authenticated binary-response entry
 * in `@core/http`, which also hands back the file name the server chose) rather than a raw `fetch` — same credentialed/error-
 * normalized transport `apiRequest` uses, just returning a `Blob`. Per the
 * `apiBlobRequest` contract, the caller is responsible for checking the
 * returned MIME type before treating the bytes as a zip.
 */
import { apiFileRequest, type FetchLike } from '@core/http'
import { saveBlobAsFile } from '@admin/shared/saveBlobAsFile'

interface DownloadStudioCodeOptions {
  /** Server default workspace when omitted. */
  dir?: string
  fetchImpl?: FetchLike
}

/** What a saved archive is called when the server names none. */
const FALLBACK_FILE_NAME = 'studio-workspace.zip'

/** Fetch the workspace source zip and validate its MIME type. Does not save it. */
export async function readStudioCodeZip(
  options: DownloadStudioCodeOptions = {},
): Promise<{ blob: Blob; fileName: string }> {
  const { blob, fileName } = await apiFileRequest('/admin/api/studio/download', {
    query: options.dir ? { dir: options.dir } : undefined,
    fallbackMessage: 'The workspace code could not be downloaded.',
    fetchImpl: options.fetchImpl,
  })
  const mimeType = blob.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (mimeType !== 'application/zip') {
    throw new Error('The server did not return a zip archive.')
  }
  return { blob, fileName: fileName ?? FALLBACK_FILE_NAME }
}

/**
 * Start a native browser download of the workspace source zip, under the name
 * the server gave it (`<project>.zip`). A hard-coded name here used to override
 * the project name the server had already put in `Content-Disposition`.
 */
export async function downloadStudioCode(options: DownloadStudioCodeOptions = {}): Promise<void> {
  const { blob, fileName } = await readStudioCodeZip(options)
  saveBlobAsFile(blob, fileName)
}
