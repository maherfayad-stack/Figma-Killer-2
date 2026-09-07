import styles from './PlanCard.module.css'
import type { Plan } from '../data/plans'

interface PlanCardProps {
  plan: Plan
}

/**
 * A local component, imported directly (rule 9) and rendered per-item inside
 * `CanonicalScreen`'s `.map` over `PLANS` (rule 4). Its own `className={styles.x}`
 * usage and its `{plan.name}` text are both read off the loop's own bound
 * parameter, so once inlined at the call site they are excluded from rules
 * 2/3/6 as data-derived content, not hand-authored JSX — see
 * `docs/reference/canonical-jsx.md`'s note on `isLoopDerivedNode`.
 */
export function PlanCard({ plan }: PlanCardProps) {
  return (
    <article className={styles.card}>
      <h3 className={styles.name}>{plan.name}</h3>
    </article>
  )
}
