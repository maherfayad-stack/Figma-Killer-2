export interface Plan {
  id: string
  name: string
}

/** A module-scope const array — the one shape `.map` may iterate over canonically (rule 4). */
export const PLANS: Plan[] = [
  { id: 'starter', name: 'Starter' },
  { id: 'team', name: 'Team' },
]

/** Used by NonCanonicalScreen.tsx to demonstrate rule 6 — a className bound to a const identifier is neither a literal string nor a `styles.x` member access. */
export const DANGER_CLASS = 'panel panel--danger'
