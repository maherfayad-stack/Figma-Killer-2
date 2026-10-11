/**
 * apiUploadRequest — `apiRequest` for a multipart upload the user is WATCHING:
 * the same credentials, the same idempotent-replay retry, the same `ApiError`
 * and the same schema-validated body, plus upload progress.
 *
 * ## Why this is not `apiRequest`
 *
 * `fetch` exposes no upload progress at all, and a dropped 20 MB photo that
 * sits on the canvas with no sign of life for eight seconds reads as a hang
 * (P5-B IMG-8: the image drop now paints a ghost that fills as the bytes go
 * up). `XMLHttpRequest`'s `upload.onprogress` is the only browser API that
 * reports it. This is the ONE place Studio's admin speaks XHR for an upload;
 * every image-landing client (`dropStudioAsset`, `uploadStudioAsset`,
 * `uploadDesignReference`) goes through it, so there is one XHR client and
 * not three hand-rolled ones.
 *
 * ## Everything else is `apiRequest`'s, not a copy of it
 *
 * XHR is used as a TRANSPORT only. Its answer is turned back into a real
 * `Response` and handed to the very functions `apiRequest` uses —
 * `retryPlanFor` (which paths may be replayed, and the idempotency key that
 * makes a replay safe), `isEmptyGatewayResponse` (the dev proxy's "nothing is
 * listening" signal), `responseErrorMessage` (the `{ error }` envelope) and
 * `parseJsonResponse` (the TypeBox boundary). So an upload retried through a
 * `bun --watch` restart replays exactly as a `/save` does, and a refusal
 * carries the server's own sentence.
 */
import type { Static, TSchema } from '@sinclair/typebox'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import {
  ApiError,
  GATEWAY_RETRY_BACKOFF_MS,
  IDEMPOTENCY_KEY_HEADER,
  isEmptyGatewayResponse,
  responseErrorMessage,
  retryPlanFor,
  sleep,
} from './apiClient'

export interface ApiUploadRequestOptions<S extends TSchema> {
  body: FormData
  /** The success body's schema — validated exactly as `apiRequest` validates one. */
  schema: S
  /** Fraction of the body sent, 0..1. Called only when the browser knows the total. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Used when a failure carries no message of its own. */
  fallbackMessage?: string
  /** Test seam, mirroring `apiRequest`'s. */
  sleepImpl?: (ms: number, signal?: AbortSignal | null) => Promise<void>
}

/** What one XHR attempt came back with, before any HTTP semantics are applied. */
interface XhrAnswer {
  status: number
  text: string
  contentType: string | null
}

const NETWORK_FAILURE_MESSAGE = 'Studio could not reach your project while uploading. Check that the dev server is running, then try again.'

function sendOnce(path: string, options: ApiUploadRequestOptions<TSchema>, headers: Record<string, string>): Promise<XhrAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path, true)
    xhr.withCredentials = true
    xhr.responseType = 'text'
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total)
    }
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        text: typeof xhr.response === 'string' ? xhr.response : (xhr.responseText ?? ''),
        contentType: xhr.getResponseHeader('content-type'),
      })
    xhr.onerror = () => reject(new ApiError(NETWORK_FAILURE_MESSAGE, 0))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))

    const { signal } = options
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(options.body)
  })
}

/** An XHR answer as the `Response` every `apiClient` helper already reads. */
function asResponse(answer: XhrAnswer): Response {
  return new Response(answer.text === '' ? null : answer.text, {
    status: answer.status,
    headers: answer.contentType ? { 'content-type': answer.contentType } : {},
  })
}

/**
 * POST `body` to `path` with upload progress; resolves the validated success
 * body or throws `ApiError` carrying the server's own sentence.
 */
export async function apiUploadRequest<S extends TSchema>(
  path: string,
  options: ApiUploadRequestOptions<S>,
): Promise<Static<S>> {
  const plan = retryPlanFor('POST', path, undefined)
  const headers: Record<string, string> = {}
  if (plan?.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = plan.idempotencyKey
  const pause = options.sleepImpl ?? sleep

  for (let attempt = 0; ; attempt += 1) {
    const answer = await sendOnce(path, options, headers)
    // `status` 0 is a request the browser never completed; `onerror` already
    // rejected for it, so every answer here has a real HTTP status.
    const res = asResponse(answer)
    if (res.ok) return parseJsonResponse(res, options.schema)

    if (plan && attempt < GATEWAY_RETRY_BACKOFF_MS.length && (await isEmptyGatewayResponse(res))) {
      await pause(GATEWAY_RETRY_BACKOFF_MS[attempt]!, options.signal)
      continue
    }
    throw new ApiError(
      await responseErrorMessage(res, options.fallbackMessage ?? `Upload failed: ${res.status}`),
      res.status,
    )
  }
}
