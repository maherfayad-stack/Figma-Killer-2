/**
 * Canonical client-side HTTP layer. Import the transport from here:
 *
 *   import { apiRequest, ApiError, isAbortError } from '@core/http'
 */
export {
  apiRequest,
  apiBlobRequest,
  ndjsonRequest,
  readEnvelope,
  assertOk,
  responseErrorMessage,
  ApiError,
  isAbortError,
  type FetchLike,
} from './apiClient'
