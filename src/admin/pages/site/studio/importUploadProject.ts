/**
 * importUploadProject — client for `POST /admin/api/studio/import-upload`
 * (the Upload / Local-folder tabs of `ImportProjectDialog`). Uses
 * `XMLHttpRequest` rather than `apiRequest`/`fetch` because upload progress
 * on a (potentially ~100 MB) archive needs `xhr.upload.onprogress` — `fetch`
 * has no upload-progress API. This is the same, deliberate exception
 * `useUploadQueue` already relies on for CMS media uploads (see its module
 * doc); this is the project-import counterpart.
 *
 * Server contract (`server/handlers/studio/importUpload.ts`):
 *   - `kind: 'zip'` — one file, unpacked server-side. The server itself
 *     decides whether to strip a shared wrapper folder (`detectSharedZipRoot`);
 *     nothing client-side to do beyond sending the raw file.
 *   - `kind: 'directory'` — N files from an `<input webkitdirectory>` picker.
 *     The browser gives each file's FULL path from the picked root via
 *     `webkitRelativePath` (e.g. `"my-app/pages/Home.tsx"`); the server does
 *     NOT strip a root segment for this shape (see that module's doc), so
 *     `stripPickedFolderName` does it here before upload.
 */
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { Type } from '@core/utils/typeboxHelpers'

export interface UploadProjectInput {
  kind: 'zip' | 'directory'
  /** One file for `kind: 'zip'`; one-or-more for `kind: 'directory'`. */
  files: File[]
  /** Human-friendly project name; slugified server-side into the target folder. */
  rootName?: string
  /** 0–1, called on each upload progress tick (only when the browser reports a computable length). */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface UploadProjectResult {
  dir: string
  files: number
  skipped: number
}

const UploadProjectResponseSchema = Type.Object({
  ok: Type.Literal(true),
  dir: Type.String(),
  files: Type.Number(),
  skipped: Type.Number(),
})

/** Non-standard but universally supported on `<input webkitdirectory>` picks; not in TS's `File` type. */
function webkitRelativePathOf(file: File): string | undefined {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined
}

/** Strips the picked folder's own leading path segment off a `webkitRelativePath`. */
export function stripPickedFolderName(relativePath: string): string {
  const firstSlash = relativePath.indexOf('/')
  return firstSlash === -1 ? relativePath : relativePath.slice(firstSlash + 1)
}

/** The picked folder's own name — the first segment of any file's `webkitRelativePath`, or `undefined` if none carry one. */
export function pickedFolderName(files: File[]): string | undefined {
  for (const file of files) {
    const relPath = webkitRelativePathOf(file)
    if (relPath) return relPath.split('/')[0]
  }
  return undefined
}

export function uploadProjectArchive(input: UploadProjectInput): Promise<UploadProjectResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.set('kind', input.kind)
    if (input.rootName) form.set('rootName', input.rootName)

    if (input.kind === 'directory') {
      for (const file of input.files) {
        const relPath = webkitRelativePathOf(file)
        form.append('file', file, relPath ? stripPickedFolderName(relPath) : file.name)
      }
    } else {
      for (const file of input.files) form.append('file', file)
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/admin/api/studio/import-upload', true)
    xhr.withCredentials = true
    xhr.responseType = 'json'

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) input.onProgress?.(event.loaded / event.total)
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = xhr.response as unknown
        if (!compiledCheck(UploadProjectResponseSchema, data)) {
          reject(new Error('Server response did not match the expected shape'))
          return
        }
        resolve({ dir: data.dir, files: data.files, skipped: data.skipped })
        return
      }
      reject(new Error(extractXhrErrorMessage(xhr) ?? `Upload failed with ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    if (input.signal) {
      if (input.signal.aborted) {
        xhr.abort()
        return
      }
      input.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.send(form)
  })
}

function extractXhrErrorMessage(xhr: XMLHttpRequest): string | null {
  const response = xhr.response as unknown
  if (response && typeof response === 'object' && 'error' in response) {
    const errorField = (response as { error?: unknown }).error
    if (typeof errorField === 'string') return errorField
  }
  return null
}
