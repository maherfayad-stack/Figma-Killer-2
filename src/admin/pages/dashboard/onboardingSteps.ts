/**
 * onboardingSteps — the wire shape of the launcher's onboarding facts, and the
 * one rule that turns them into per-step done / active / todo.
 *
 * Kept out of the panel and out of the hook so the rule is testable without a
 * React tree or a network stub: it is a pure function of five booleans.
 *
 * `OnboardingFactsSchema` mirrors `server/handlers/studio/onboardingFacts.ts`
 * rather than importing it — that module reads the filesystem and the database
 * and cannot be loaded in a browser. Same posture, and the same reason, as
 * `studioProjectTrust.ts`'s mirror of `TrustTierSchema`: the two halves only
 * have to agree on the wire, and this half is validated against the schema
 * below at the boundary.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const OnboardingFactsSchema = Type.Object(
  {
    /** At least one project exists under `studio-workspace/`. */
    projectCreated: Type.Boolean(),
    /** Some project has been loaded on the board at least once. */
    projectOpened: Type.Boolean(),
    /** Some project's source has changed since it was checked out or scaffolded. */
    styleEdited: Type.Boolean(),
    /** This user has an AI credential or has held a conversation. */
    aiConfigured: Type.Boolean(),
    /** Some project has at least one authored prototype link. */
    prototypeLinked: Type.Boolean(),
  },
  { additionalProperties: true },
)
export type OnboardingFacts = Static<typeof OnboardingFactsSchema>

/** One step's id — the key of the fact that decides it. */
export type OnboardingStepId = keyof OnboardingFacts

/**
 * The steps, in the order they are rendered AND in the order they are most
 * naturally done. The order matters for more than layout: `active` is the
 * first not-yet-done step in this list.
 */
export const ONBOARDING_STEP_IDS = [
  'projectCreated',
  'projectOpened',
  'styleEdited',
  'aiConfigured',
  'prototypeLinked',
] as const satisfies readonly OnboardingStepId[]

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEP_IDS.length

export type OnboardingStepState = 'done' | 'active' | 'todo'

/**
 * Each step's state.
 *
 * A step is `done` when its fact is true — in any order, because the facts are
 * independent reads of real state and a user who wired a prototype before
 * touching the AI panel genuinely did that. Exactly one step is `active`: the
 * FIRST one that is not done, which is the panel's answer to "what now". Every
 * other undone step is `todo` and reads as available, not blocked — nothing
 * here gates anything.
 */
export function onboardingStepStates(
  facts: OnboardingFacts,
): Record<OnboardingStepId, OnboardingStepState> {
  const firstUndone = ONBOARDING_STEP_IDS.find((id) => !facts[id])
  const states = {} as Record<OnboardingStepId, OnboardingStepState>
  for (const id of ONBOARDING_STEP_IDS) {
    states[id] = facts[id] ? 'done' : id === firstUndone ? 'active' : 'todo'
  }
  return states
}

/** How many of the five steps are done. */
export function onboardingDoneCount(facts: OnboardingFacts): number {
  return ONBOARDING_STEP_IDS.filter((id) => facts[id]).length
}

/** True when there is nothing left to do — the panel hides itself rather than congratulating anyone. */
export function isOnboardingComplete(facts: OnboardingFacts): boolean {
  return onboardingDoneCount(facts) === ONBOARDING_STEP_COUNT
}
