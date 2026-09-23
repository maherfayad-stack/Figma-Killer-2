/**
 * BoardBanners — the board's bottom-centre stack of project-level banners.
 *
 * Every one of these answers the same shape of question: "this whole project
 * is in a state you cannot see, and here is the one click that changes it."
 * They self-gate (each renders `null` unless it has something to offer), so
 * the stack is usually empty — and when two of them DO apply at once, they
 * have to be somewhere other than on top of each other. That is the only
 * reason this component exists: bottom-centre is one slot, and two absolutely
 * positioned cards claiming it overlap.
 *
 * Order is precedence. The design-system migration comes first because a
 * project importing a package that no longer exists does not build at all,
 * which is a larger problem than styles that have not been compiled.
 *
 * The stack itself is `pointer-events: none`, so an empty one never eats a
 * board click; each card turns them back on for itself.
 *
 * `LiveAutoPromoteNotice`, once the third card here, was retired when the
 * owner made every project start at Tier 2 (`run-project`) by default
 * (2026-09-20) — there is no lower default left to promote FROM, so nothing
 * ever needs announcing. `LiveRuntimePill`'s "Back to static" is the durable
 * way to see and change a project's tier now.
 */
import { DesignSystemMigrateBanner } from '../DesignSystemMigrateBanner'
import { StyleCompileConsentBanner } from '../StyleCompileConsentBanner'
import styles from './BoardBanners.module.css'

export function BoardBanners() {
  return (
    <div className={styles.stack}>
      <DesignSystemMigrateBanner />
      <StyleCompileConsentBanner />
    </div>
  )
}
