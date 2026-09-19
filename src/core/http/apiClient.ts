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
 * GATEWAY-DOWN RETRY: every call also retries, silently, an empty-bodied
 * 502/503/504 (see `GATEWAY_STATUSES` and {@link GATEWAY_RETRY_BACKOFF_MS}) —
 * the shape the Vite dev proxy answers with when nothing is listening on the
 * API port, e.g. the second or two `bun --watch server/index.ts` spends
 * restarting after a file change. A response the real server DID construct
 * (a genuine `{ error }` envelope, even one that happens to use a
 * 502/503/504 status) is a real answer and is never retried.
 *
 * That empty-body shape is NOT proof the request never ran, though — it is
 * two failures collapsed into one indistinguishable response. ECONNREFUSED
 * (nothing was listening) really did mean zero server-side effect. A
 * connection RESET mid-flight does not: `bun --watch` restarts on a file
 * change, often the very file the handler just wrote, and a handler can
 * finish its disk write and then die before the response headers go out.
 * Vite's proxy answers both cases with the same empty 502/503/504, so the
 * client cannot tell them apart from the response alone.
 *
 * So the retry is unconditional only for GET/HEAD, where "ran or didn't"
 * never matters. For a state-changing method, blindly retrying would risk
 * re-running an already-landed write — a `duplicate` that already copied a
 * node would copy it again. Those methods retry ONLY on the small,
 * explicitly named set of routes in `IDEMPOTENT_REPLAY_PATHS`, and only by
 * attaching a per-attempt `X-Studio-Idempotency-Key` header that the SERVER
 * uses to recognise a replay and hand back the original response instead of
 * running the route again (`server/handlers/studio/idempotentReplay.ts`).
 * The safety proof lives server-side, not in an inference from the response
 * shape. A state-changing call to any OTHER path is never retried — it
 * surfaces its error immediately, same as before this feature existed.
 * Disable retrying a specific call (including GET/HEAD) with
 * `retryGatewayDown: false`.
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
 * Backoff ladder for the gateway-down retry described in the module doc
 * comment. Three rungs, ~5s total — long enough to ride out a `bun --watch`
 * restart (typically under two seconds) without making a genuinely offline
 * backend feel slow to report itself.
 */
export const GATEWAY_RETRY_BACKOFF_MS = [500, 1500, 3000] as const

/** Methods where "ran or didn't" never changes the answer — always safe to retry, on any path. */
const ALWAYS_SAFE_METHODS = new Set(['GET', 'HEAD'])

/**
 * The exact, narrow set of state-changing Studio routes whose server side
 * durably records `(idempotency key → response)` — see
 * `server/handlers/studio/idempotentReplay.ts` for the full mechanism and
 * why the record lives where it does. A state-changing request to a path NOT
 * in this set is never retried on a gateway-down response: there is no
 * server-side proof available that a replay is safe, so the honest answer is
 * to surface the error rather than guess.
 *
 * Deliberately a short, explicit allowlist rather than "every mutating
 * route" — extending it means adding the matching server-side guard in the
 * same change, not just flipping a client-side switch.
 */
const IDEMPOTENT_REPLAY_PATHS = new Set([
  '/admin/api/studio/save',
  '/admin/api/studio/page',
  '/admin/api/studio/boards',
])

/** The header carrying the per-attempt request id — see the module doc and `IDEMPOTENT_REPLAY_PATHS`. */
const IDEMPOTENCY_KEY_HEADER = 'X-Studio-Idempotency-Key'

/**
 * Whether a gateway-down response for `method`+`path` may be retried at all,
 * and (for a state-changing method) the idempotency key to attach on every
 * attempt so the server can recognise a replay. `null` for "do not retry".
 */
function retryPlanFor(method: string, path: string): { idempotencyKey: string | null } | null {
  const upper = method.toUpperCase()
  if (ALWAYS_SAFE_METHODS.has(upper)) return { idempotencyKey: null }
  if (IDEMPOTENT_REPLAY_PATHS.has(path)) return { idempotencyKey: crypto.randomUUID() }
  return null
}

/** Real-timer sleep, abortable — the default `sleepImpl`; tests inject a fast stand-in. */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/**
 * True when `res` is a gateway status AND its body is empty — the signal that
 * nothing was listening on the API port, per the module doc comment. Reads
 * via `res.clone()` so the body is still intact for the caller (or the next
 * retry attempt's own error path) to read again.
 */
async function isEmptyGatewayResponse(res: Response): Promise<boolean> {
  if (!GATEWAY_STATUSES.has(res.status)) return false
  try {
    const text = await res.clone().text()
    return text.trim() === ''
  } catch {
    return false
  }
}

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
  /**
   * Retry an empty-bodied 502/503/504 (see the module doc comment and
   * `retryPlanFor`). Defaults to `true`; the retry itself only fires for
   * GET/HEAD or for a state-changing method on one of
   * `IDEMPOTENT_REPLAY_PATHS`, so this flag is a blanket "never retry this
   * call" override rather than something every call site must reason about.
   */
  retryGatewayDown?: boolean
  /** Injectable backoff sleep — test seam only; defaults to a real timer. */
  sleepImpl?: (ms: number, signal?: AbortSignal | null) => Promise<void>
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
    retryGatewayDown = true,
    sleepImpl = sleep,
  } = options

  // `null` means "do not retry this call at all" — either the caller opted
  // out, or `retryPlanFor` found no server-side safety proof for this
  // method+path combination.
  const plan = retryGatewayDown ? retryPlanFor(method, path) : null

  const finalHeaders: Record<string, string> = { ...headers }
  if (plan?.idempotencyKey) finalHeaders[IDEMPOTENCY_KEY_HEADER] = plan.idempotencyKey

  const init: RequestInit = { method, credentials }
  if (signal) init.signal = signal

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      finalHeaders['Content-Type'] ??= 'application/json'
    }
  }
  if (Object.keys(finalHeaders).length > 0) init.headers = finalHeaders

  const url = buildUrl(path, query)

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, init)
    if (res.ok) return res

    if (plan && attempt < GATEWAY_RETRY_BACKOFF_MS.length && (await isEmptyGatewayResponse(res))) {
      await sleepImpl(GATEWAY_RETRY_BACKOFF_MS[attempt]!, signal)
      continue
    }

    throw new ApiError(
      await responseErrorMessage(res, fallbackMessage ?? `Request failed: ${res.status}`),
      res.status,
    )
  }
}
