# Canonical JSX fixture

**This is not user data.** Every other directory under `studio-workspace/` is a
real (or test-seeded) user project — never delete or clear one. This one is
different: it is a small, deliberately-authored reference project, committed
as part of `docs/reference/canonical-jsx.md`'s verification target (WS-13 §5).
The leading `__` on the directory name marks that distinction.

It exists so `src/core/page-parser/__tests__/canonicalCheck.test.ts` has real
source to parse, instead of one more fixture grown from the eSIM corpus's own
habits. It is not meant to be opened as a Studio project, though nothing stops
you from doing so.

## Layout

| File | Purpose |
|---|---|
| `src/screens/CanonicalScreen.tsx` | Exercises the canonical shape of every rule in `docs/reference/canonical-jsx.md` §2 that has one. |
| `src/screens/NonCanonicalScreen.tsx` | One clearly labelled section per rule, each violating exactly that rule. |
| `src/screens/NonCanonicalScreen.scss` | The rule-7 violation — a Sass stylesheet import. |
| `src/screens/CanonicalScreen.css` / `.module.css` | The rule-7 canonical shapes — plain CSS and a CSS Module. |
| `src/components/PlanCard.tsx` + `.module.css` | A local component the canonical screen imports directly (rule 9) and maps over (rule 4). |
| `src/data/plans.ts` | The module-scope const array/data rule 4 and rule 6's negative example read. |

See `docs/reference/canonical-jsx.md` for what each rule checks and why.
