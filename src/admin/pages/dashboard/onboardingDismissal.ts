/**
 * onboardingDismissal — remembering that a user dismissed the launcher's
 * onboarding checklist.
 *
 * ## Why localStorage and not the database
 *
 * This is a UI preference about a panel, and Studio's state belongs on disk or
 * in the browser, not in the inherited CMS schema (CLAUDE.md: "Studio state
 * belongs on disk, not in the database"). Adding a `user_preferences` row would
 * mean a round trip before the launcher can decide whether to draw its largest
 * surface, which is the one place a preference read must not be async.
 *
 * ## Why it is keyed by user id
 *
 * `localStorage` is per browser, and two people sharing a machine share it.
 * Storing a list of user ids rather than a single boolean means the second
 * account gets its own checklist instead of inheriting the first one's
 * dismissal — the same reason every other per-user preference is per user.
 * The stored ids are already-authenticated ids the browser has, so this reveals
 * nothing an attacker with the machine could not read from the session anyway.
 *
 * ## One-way
 *
 * There is no un-dismiss. The panel says so before it goes, and a checklist
 * that can come back is a checklist a user has to dismiss twice.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

export const ONBOARDING_DISMISSAL_STORAGE_KEY = 'studio-onboarding-dismissed-v1'

/** How many ids to keep. A shared machine has a handful of accounts, not a thousand. */
const MAX_REMEMBERED_USERS = 50

const DismissalSchema = Type.Object(
  { userIds: Type.Array(Type.String(), { maxItems: MAX_REMEMBERED_USERS }) },
  { additionalProperties: false },
)
type Dismissal = Static<typeof DismissalSchema>

const EMPTY: Dismissal = { userIds: [] }

function read(): Dismissal {
  try {
    return parseJsonWithFallback(localStorage.getItem(ONBOARDING_DISMISSAL_STORAGE_KEY), DismissalSchema, EMPTY)
  } catch {
    // A browser with storage disabled (or a private-mode quota error) is not a
    // reason to fail the launcher — the user just sees the checklist again.
    return EMPTY
  }
}

/** True when `userId` has already dismissed the checklist in this browser. */
export function isOnboardingDismissed(userId: string): boolean {
  return read().userIds.includes(userId)
}

/** Records the dismissal. A write failure is silent: the panel is already hidden in this session's own state. */
export function dismissOnboarding(userId: string): void {
  const existing = read().userIds.filter((id) => id !== userId)
  // Newest first, oldest dropped past the cap — the account that just
  // dismissed is the one whose choice must survive.
  const userIds = [userId, ...existing].slice(0, MAX_REMEMBERED_USERS)
  try {
    localStorage.setItem(ONBOARDING_DISMISSAL_STORAGE_KEY, JSON.stringify({ userIds }))
  } catch (err) {
    console.error('[onboardingDismissal] could not persist the dismissal:', err)
  }
}
