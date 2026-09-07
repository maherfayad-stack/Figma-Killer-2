/**
 * useOnboardingFacts — one request for the five booleans the launcher's
 * `OnboardingPanel` renders.
 *
 * `GET /admin/api/studio/onboarding` runs the five probes concurrently on the
 * server and answers with all five at once (see
 * `server/handlers/studio/onboardingFacts.ts` for why the fan-out lives there
 * and not here). This hook is therefore the ordinary single-resource shape,
 * validated at the JSON boundary against `OnboardingFactsSchema`.
 *
 * A failed load yields `null`, and the panel is not rendered at all. That is
 * the deliberate choice over defaulting to all-false: showing a user who has
 * done everything a checklist claiming they have done nothing is worse than
 * showing no checklist, and the panel is not what they came to the launcher
 * for. `swallowErrors` keeps the failure out of the page's own error surface —
 * the project grid's listing is what a user needs to be told about.
 */
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { OnboardingFactsSchema, type OnboardingFacts } from '../onboardingSteps'

const OnboardingResponseSchema = Type.Object(
  { facts: OnboardingFactsSchema },
  { additionalProperties: true },
)

export interface OnboardingFactsResource {
  /** The five facts, or null before the first success and after a failure. */
  facts: OnboardingFacts | null
  /** True while a load is in flight, including the initial one. */
  loading: boolean
  /** Re-runs the read. Stable identity. */
  refresh: () => void
}

export function useOnboardingFacts(): OnboardingFactsResource {
  const resource = useAsyncResource(
    (signal) => apiRequest('/admin/api/studio/onboarding', { schema: OnboardingResponseSchema, signal }),
    [],
    { swallowErrors: true },
  )
  return { facts: resource.data?.facts ?? null, loading: resource.loading, refresh: resource.refresh }
}
