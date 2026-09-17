import './CanonicalScreen.css'
import heroStyles from './CanonicalScreen.module.css'
import { Button } from '@alm-design/design-system'
import { PlanCard } from '../components/PlanCard'
import { PLANS } from '../data/plans'

/**
 * Exercises the canonical shape of every rule in
 * `docs/reference/canonical-jsx.md` §2 that has one. Paired with
 * `NonCanonicalScreen.tsx`.
 *
 * `className={heroStyles.hero}` on the root section is deliberately kept —
 * it is the canonical `styles.x` shape rule 6 permits, and it still
 * produces an informational `static-class-name` finding (documented and
 * expected: the value cannot be typed over in the Properties panel). Rule
 * 6's own zero-finding example is the literal `className="canonical-screen__icon"`
 * on the `<svg>` below.
 */
export default function CanonicalScreen() {
  return (
    <section className={heroStyles.hero}>
      {/* rule 3 (literal-text): a plain JSX text child. */}
      <h1>Book your trip</h1>

      {/* rule 2 (literal-props) + rule 9 (direct-component-imports, package):
          every prop is a literal, and Button is imported from an npm
          design system — the best case, not an exception (see the doc's
          "npm design systems" section). */}
      <Button variant="primary" size="large">
        Book now
      </Button>

      {/* rule 8 (static-svg) + rule 6 (static-class-name, literal shape):
          a static inline <svg> with no dynamic attributes, and a plain
          string className. */}
      <svg className="canonical-screen__icon" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
      </svg>

      {/* rule 4 (const-array-map) + rule 9 (direct-component-imports, local):
          .map over a module-scope const array, over a directly-imported
          local component. Each row locks with "item N of PLANS…", which is
          the expected non-finding outcome for rule 4. */}
      {PLANS.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </section>
  )
}
