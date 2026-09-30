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
  GATEWAY_RETRY_BACKOFF_MS,
  type FetchLike,
} from './apiClient'
export { apiUploadRequest, type ApiUploadRequestOptions } from './uploadRequest'
export {
  isUnreachableFailure,
  retryWhileUnreachable,
  setUnreachableRetrySleepForTests,
  UNREACHABLE_RETRY_BACKOFF_MS,
  type RetryWhileUnreachableOptions,
} from './retryUnreachable'
