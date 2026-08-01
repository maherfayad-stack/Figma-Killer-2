/**
 * Canonical client-side HTTP + JSON client for the admin app.
 *
 * Every browser→server call in `src/` funnels through `apiRequest` (or, for
 * code that already holds a `Response`, through `readEnvelope`). This is the
 * ONE place that:
 *
 *   - sets `credentials: 'include'` by default,
 *   - serializes a JSON body + `Content-Type` header (FormData passes through),
 *   - on a non-OK response, reads the server `{ error }` envelope via
 *     `responseErrorMessage` and throws a single typed {@link ApiError}
 *     carrying the HTTP status,
 *   - validates the success body against a TypeBox schema (constraint #272 —
 *     every untyped boundary is validated before reaching React state).
 *
 * Cancellation is uniform: an aborted request rejects with the underlying
 * `AbortError`; callers detect it with {@link isAbortError} instead of
 * hand-rolling `(err as Error).name === 'AbortError'` at each call site.
 *
 * This module is the generic transport layer — it depends on nothing in
 * `@core/persistence`. The persistence layer (and everything else) depends on
 * it, never the reverse.
 */

import type { TSchema, Static } from '@sinclair/typebox'
import { Type } from '@core/utils/typeboxHelpers'
import { parseJsonResponse, safeParseJson } from '@core/utils/jsonValidate'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Error envelope returned by every CMS / AI endpoint on failure. Validated
 * (loosely — `error` is optional and extra keys are allowed) so a non-JSON or
 * differently-shaped body falls through to the text/fallback branches in
 * {@link responseErrorMessage} instead of throwing.
 */
const ErrorEnvelopeSchema = Type.Object(
  { error: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

/**
 * The single error type thrown for every failed HTTP call. Carries the HTTP
 * status so UI can branch on it (e.g. 403 → "no access", 404 → "not found").
 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** True for an aborted fetch (user cancellation / superseded request). */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

/**
 * Statuses the Vite dev proxy returns, with an empty body, when nothing is
 * listening on the API port. The server itself never answers these — it either
 * responds with an `{ error }` envelope or does not respond at all — so an
 * empty one is an unambiguous "the backend is down" in this app's topology.
 */
const GATEWAY_STATUSES = new Set([502, 503, 504])

/**
 * Best-effort human-readable message for a failed `Response`. Prefers the
 * server `{ error }` envelope, then the raw response text, then a
 * backend-is-down message for an empty gateway error, then `fallback`.
 * Uses `res.clone()` so the body can still be read again by the caller.
 *
 * The gateway branch exists because the fallback lies in exactly the case a
 * developer hits most: with the API server stopped, every call gets an empty
 * 502 and reports whatever its caller named as a generic failure — a login
 * attempt came back "CMS login failed", which reads as "wrong password" and
 * sends you to check your credentials instead of your terminal. The status
 * alone is enough to say what actually happened.
 */
export async function responseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await parseJsonResponse(res.clone(), ErrorEnvelopeSchema)
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Not a JSON error envelope — fall through to text.
  }

  try {
    const text = await res.text()
    if (text.trim()) return text.trim()
  } catch {
    // Body unreadable — fall through to fallback.
  }

  if (GATEWAY_STATUSES.has(res.status)) {
    return `The Studio server isn't responding (${res.status}). Start it with \`bun run dev\`, then try again.`
  }

  return fallback
}

/**
 * Throw {@link ApiError} if a `Response` is not OK, otherwise return. The
 * no-body counterpart to {@link readEnvelope} — for persistence calls that
 * perform their own `fetch` and either return void or parse the body
 * separately afterwards.
 */
export async function assertOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    throw new ApiError(await responseErrorMessage(res, fallback), res.status)
  }
}

/**
 * Validate an already-fetched `Response`. Throws {@link ApiError} on a non-OK
 * status (message from {@link responseErrorMessage}), otherwise validates the
 * body against `schema`. For the persistence layer, which performs its own
 * `fetch` (with an injectable `fetchImpl`) and then hands the response here.
 */
export async function readEnvelope<T extends TSchema>(
  res: Response,
  schema: T,
  fallback: string,
): Promise<Static<T>> {
  if (!res.ok) {
    throw new ApiError(await responseErrorMessage(res, fallback), res.status)
  }
  return parseJsonResponse(res, schema)
}

interface ApiRequestOptions<S extends TSchema = TSchema> {
  method?: string
  /**
   * Request body. A `FormData` value is sent as-is; anything else is
   * `JSON.stringify`-ed with a `Content-Type: application/json` header.
   */
  body?: unknown
  /** TypeBox schema to validate the success body against. Omit for no-content responses. */
  schema?: S
  /** Query params appended to `path`. `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal | null
  headers?: Record<string, string>
  /** Defaults to `'include'`. */
  credentials?: RequestCredentials
  /** Message used when the server provides no error envelope/text. */
  fallbackMessage?: string
  /** Injectable fetch — test seam only; defaults to the global `fetch`. */
  fetchImpl?: FetchLike
}

function buildUrl(path: string, query?: ApiRequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  if (!qs) return path
  return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
}

// Overloads: with a schema the call resolves to the validated value; without
// one it resolves to void (no-content / fire-and-forget mutations).
export async function apiRequest<S extends TSchema>(
  path: string,
  options: ApiRequestOptions<S> & { schema: S },
): Promise<Static<S>>
export async function apiRequest(path: string, options?: ApiRequestOptions): Promise<void>
export async function apiRequest<S extends TSchema>(
  path: string,
  options: ApiRequestOptions<S> = {},
): Promise<Static<S> | void> {
  const res = await requestResponse(path, options)
  if (!options.schema) return
  return parseJsonResponse(res, options.schema)
}

/**
 * Fetch a binary response through the same authenticated/error-normalized
 * transport as {@link apiRequest}. Binary bodies have no TypeBox shape to
 * validate; callers remain responsible for checking the returned MIME type
 * before treating the bytes as a specific file kind.
 */
export async function apiBlobRequest(
  path: string,
  options: Omit<ApiRequestOptions, 'schema'> = {},
): Promise<Blob> {
  const res = await requestResponse(path, options)
  return res.blob()
}

/**
 * Stream a newline-delimited-JSON response through the same authenticated/
 * error-normalized transport `apiRequest` uses (`requestResponse` — same
 * `credentials`, query serialization, and `{ error }`-envelope handling on a
 * non-OK status), validating and delivering ONE value per line as it
 * arrives, rather than waiting for the whole body.
 *
 * Reserved for the class of endpoint where that actually matters — a large,
 * genuinely incremental payload where a caller can usefully act on the first
 * items before the last one has arrived (WS-5.5's studio page load: the
 * first board frame can render while later pages are still in flight). Every
 * other response goes through {@link apiRequest}'s single validated
 * envelope; this is not a general substitute for it.
 */
export async function ndjsonRequest<S extends TSchema>(
  path: string,
  options: Omit<ApiRequestOptions, 'schema'> & { lineSchema: S; onLine: (value: Static<S>) => void },
): Promise<void> {
  const { lineSchema, onLine, ...rest } = options
  const res = await requestResponse(path, rest)
  const reader = res.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const parsed = safeParseJson(trimmed, lineSchema)
    if (!parsed.ok) throw parsed.error
    onLine(parsed.value)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex))
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
    }
    if (done) break
  }
  consumeLine(buffer)
}

async function requestResponse(
  path: string,
  options: Omit<ApiRequestOptions, 'schema'> | ApiRequestOptions,
): Promise<Response> {
  const {
    method = 'GET',
    body,
    query,
    signal,
    headers,
    credentials = 'include',
    fallbackMessage,
    fetchImpl = globalThis.fetch.bind(globalThis),
  } = options

  const init: RequestInit = { method, credentials }
  if (signal) init.signal = signal

  const finalHeaders: Record<string, string> = { ...headers }
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      finalHeaders['Content-Type'] ??= 'application/json'
    }
  }
  if (Object.keys(finalHeaders).length > 0) init.headers = finalHeaders

  const res = await fetchImpl(buildUrl(path, query), init)

  if (!res.ok) {
    throw new ApiError(
      await responseErrorMessage(res, fallbackMessage ?? `Request failed: ${res.status}`),
      res.status,
    )
  }
  return res
}
