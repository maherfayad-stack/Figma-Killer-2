/**
 * OnboardingPanel — the five-step setup checklist above the launcher grid.
 *
 * Every step's state comes from `useOnboardingFacts` — a live read of what is
 * on disk and in this user's rows — so steps tick as the user genuinely does
 * the thing, in any order, and never because they looked at a screen. A step
 * whose fact cannot be answered reads as not done (the safe direction: at
 * worst the user is invited to do something they already did).
 *
 * Every CTA performs the real action, not a tour of where the action lives:
 * "New project" opens the create dialog the toolbar opens, "Open a project"
 * opens the most recently edited one on the board, "Open AI settings" opens the
 * same Settings section the agent panel's own empty state opens, and
 * "Open prototype mode" opens a project already in prototype mode
 * (`?mode=prototype`, consumed by `useSiteEditorUrlSync`).
 *
 * Layout — two columns, collapsing to one on a narrow viewport:
 *
 *   ┌──────────────────────┬───────────────────────────────────┐
 *   │   (progress ring)    │  step 1 — full-width row          │
 *   │                      ├───────────────────────────────────┤
 *   │   Set up Studio      │  step 2                           │
 *   │                      ├───────────────────────────────────┤
 *   │   short description  │  …                                │
 *   │                      │                                   │
 *   │   [Dismiss]          │                                   │
 *   └──────────────────────┴───────────────────────────────────┘
 *
 * The panel has no collapsed in-between state. It is shown until the user
 * dismisses it (once, for good — `onboardingDismissal.ts`) or until all five
 * steps are done, at which point `DashboardPage` stops rendering it: a
 * completed checklist has nothing left to say.
 */
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { Button } from '@ui/components/Button'
import type { PixelArtIconComponent } from '@core/dashboard'
import { LiquidProgressRing } from './LiquidProgressRing'
import {
  ONBOARDING_STEP_COUNT,
  onboardingDoneCount,
  onboardingStepStates,
  type OnboardingFacts,
  type OnboardingStepId,
  type OnboardingStepState,
} from './onboardingSteps'
import styles from './OnboardingPanel.module.css'

/**
 * What a step's button does. Named rather than a closure per step so the table
 * below stays a description of the checklist and the wiring stays in one
 * `switch` — and so a step cannot quietly grow a second behaviour.
 */
export type OnboardingAction =
  | 'create-project'
  | 'open-project'
  | 'open-ai-settings'
  | 'open-prototype-mode'

interface StepDef {
  id: OnboardingStepId
  title: string
  desc: string
  cta: string
  icon: PixelArtIconComponent
  action: OnboardingAction
}

/**
 * The checklist. Order matters — `onboardingStepStates` makes the first undone
 * step the active one, and this is the order a user most naturally works in.
 */
const STEPS: readonly StepDef[] = [
  {
    id: 'projectCreated',
    title: 'Create or import a project',
    desc: 'A project is a real React repository under studio-workspace/. Start a blank one, or import an existing repo from GitHub, a .zip, or a folder on this machine.',
    cta: 'New project',
    icon: PlusIcon,
    action: 'create-project',
  },
  {
    id: 'projectOpened',
    title: 'Open it on the board',
    desc: 'Every page in the project becomes a live frame you can pan, zoom and select in. Studio records the open in the project’s .studio/meta.json.',
    cta: 'Open a project',
    icon: LayoutSolidIcon,
    action: 'open-project',
  },
  {
    id: 'styleEdited',
    title: 'Edit an element’s style',
    desc: 'Select anything on a frame and the Properties panel edits its real CSS. The change is written back into the file it came from — there is no export step.',
    cta: 'Open a project',
    icon: CursorClickSolidIcon,
    action: 'open-project',
  },
  {
    id: 'aiConfigured',
    title: 'Set up the AI assistant',
    desc: 'Add a provider API key, or sign in with the Claude CLI. The assistant reads and writes the same files the canvas does.',
    cta: 'Open AI settings',
    icon: AiBoxSolidIcon,
    action: 'open-ai-settings',
  },
  {
    id: 'prototypeLinked',
    title: 'Try prototype mode',
    desc: 'Draw a link from an element on one frame to another frame, then play the flow. Links are saved in the project’s .studio/prototype.json.',
    cta: 'Open prototype mode',
    icon: LinkIcon,
    action: 'open-prototype-mode',
  },
]

interface OnboardingPanelProps {
  facts: OnboardingFacts
  /**
   * True when there is at least one project to open. The three steps that act
   * on a project have nothing to open without one, so their buttons are
   * disabled rather than navigating to an empty board.
   */
  hasProject: boolean
  /** Runs the step's real action. `DashboardPage` owns every one of them. */
  onRunAction: (action: OnboardingAction) => void
  onDismiss: () => void
}

function stateLabel(state: OnboardingStepState): string {
  if (state === 'done') return 'Done'
  if (state === 'active') return 'Next'
  return 'Not started'
}

export function OnboardingPanel({ facts, hasProject, onRunAction, onDismiss }: OnboardingPanelProps) {
  const states = onboardingStepStates(facts)
  const done = onboardingDoneCount(facts)

  return (
    <section className={styles.onboarding} aria-label="Setup checklist">
      <header className={styles.head}>
        <div className={styles.headBlock}>
          <LiquidProgressRing value={done} total={ONBOARDING_STEP_COUNT} />
          <h2 className={styles.headTitle}>Set up Studio</h2>
          <p className={styles.headDesc}>
            {done} of {ONBOARDING_STEP_COUNT} done. Each step ticks itself when you do the thing, in any
            order. Dismissing hides this checklist for good.
          </p>
        </div>
        <div className={styles.headActions}>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </header>

      <ol className={styles.steps}>
        {STEPS.map((step, index) => {
          const state = states[step.id]
          const StepIcon = step.icon
          const needsProject = step.action !== 'create-project'
          return (
            <li className={styles.step} data-state={state} key={step.id}>
              <span className={styles.stepCheck} aria-hidden="true">
                {state === 'done' ? <CheckIcon size={11} /> : String(index + 1).padStart(2, '0')}
              </span>
              <span className={styles.stepIcon} aria-hidden="true">
                <StepIcon size={14} />
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  <span className={styles.stepIndex}>STEP {String(index + 1).padStart(2, '0')}</span>
                  <span>{step.title}</span>
                </div>
                <div className={styles.stepDesc}>{step.desc}</div>
              </div>
              <div className={styles.stepCta}>
                <span className={styles.stepHint} data-state={state}>
                  {stateLabel(state)}
                </span>
                <Button
                  variant={state === 'done' ? 'ghost' : state === 'active' ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={needsProject && !hasProject}
                  onClick={() => onRunAction(step.action)}
                >
                  {step.cta}
                  <ChevronRightIcon size={10} aria-hidden="true" />
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
