/**
 * onboardingSteps — the rule that turns five facts into five step states.
 *
 * Two things are being pinned here. Steps are INDEPENDENT: a user who wired a
 * prototype before touching the AI panel really did that, and a checklist that
 * refused to tick step 5 until step 4 was done would be calling them a liar.
 * And exactly one step is `active` — the first undone one — because "what now"
 * has one answer and a panel that highlights four things highlights nothing.
 */
import { describe, expect, it } from 'bun:test'
import {
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEP_IDS,
  isOnboardingComplete,
  onboardingDoneCount,
  onboardingStepStates,
  type OnboardingFacts,
} from './onboardingSteps'

const NOTHING_DONE: OnboardingFacts = {
  projectCreated: false,
  projectOpened: false,
  styleEdited: false,
  aiConfigured: false,
  prototypeLinked: false,
}

const ALL_DONE: OnboardingFacts = {
  projectCreated: true,
  projectOpened: true,
  styleEdited: true,
  aiConfigured: true,
  prototypeLinked: true,
}

describe('onboardingStepStates', () => {
  it('makes the first step active on a fresh install and the rest todo', () => {
    expect(onboardingStepStates(NOTHING_DONE)).toEqual({
      projectCreated: 'active',
      projectOpened: 'todo',
      styleEdited: 'todo',
      aiConfigured: 'todo',
      prototypeLinked: 'todo',
    })
  })

  it('moves `active` to the first step that is not done', () => {
    const states = onboardingStepStates({ ...NOTHING_DONE, projectCreated: true, projectOpened: true })

    expect(states.projectCreated).toBe('done')
    expect(states.projectOpened).toBe('done')
    expect(states.styleEdited).toBe('active')
    expect(states.aiConfigured).toBe('todo')
  })

  it('ticks steps done out of order, and keeps `active` on the earliest gap', () => {
    // The user set up AI and drew a prototype link before ever opening the
    // Properties panel. Both of those genuinely happened.
    const states = onboardingStepStates({
      ...NOTHING_DONE,
      projectCreated: true,
      projectOpened: true,
      aiConfigured: true,
      prototypeLinked: true,
    })

    expect(states.aiConfigured).toBe('done')
    expect(states.prototypeLinked).toBe('done')
    // The one gap is what "next" points at — not the last step in the list.
    expect(states.styleEdited).toBe('active')
  })

  it('marks every step done with nothing active once all five facts are true', () => {
    const states = onboardingStepStates(ALL_DONE)

    expect(Object.values(states)).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('covers every declared step id', () => {
    expect(Object.keys(onboardingStepStates(NOTHING_DONE)).sort()).toEqual([...ONBOARDING_STEP_IDS].sort())
    expect(ONBOARDING_STEP_COUNT).toBe(5)
  })
})

describe('onboardingDoneCount / isOnboardingComplete', () => {
  it('counts the true facts', () => {
    expect(onboardingDoneCount(NOTHING_DONE)).toBe(0)
    expect(onboardingDoneCount({ ...NOTHING_DONE, projectCreated: true, prototypeLinked: true })).toBe(2)
    expect(onboardingDoneCount(ALL_DONE)).toBe(ONBOARDING_STEP_COUNT)
  })

  it('is complete only at five of five — the panel hides itself there', () => {
    expect(isOnboardingComplete(NOTHING_DONE)).toBe(false)
    expect(isOnboardingComplete({ ...ALL_DONE, styleEdited: false })).toBe(false)
    expect(isOnboardingComplete(ALL_DONE)).toBe(true)
  })
})
