import './NonCanonicalScreen.scss'
import { DANGER_CLASS, PLANS } from '../data/plans'

/**
 * One clearly labelled section per rule in `docs/reference/canonical-jsx.md`
 * §2, each violating exactly that rule. Paired with `CanonicalScreen.tsx`.
 * Not typechecked (`studio-workspace/` sits outside `tsconfig.app.json`'s
 * `include`) — some references below are deliberately undeclared, exactly
 * the shape ts-morph has to cope with in a real, unvetted import.
 */
export default function NonCanonicalScreen() {
  return (
    <div className="non-canonical-screen">
      {/* rule 1 (single-return): Math.random is deliberately excluded from
          Tier A, so this condition is never statically decidable — the
          parser must auto-select a branch. */}
      {Math.random() > 0.5 ? <p>Heads</p> : <p>Tails</p>}

      {/* rule 2 (literal-props): bound to a computed access into imported
          data, not a literal or a bare module-scope const reference. */}
      <span data-label={PLANS[0].name} />

      {/* rule 3 (literal-text): text read off that same computed access. */}
      <p>{PLANS[0].name}</p>

      {/* rule 4 (const-array-map): .map over data the parser cannot read
          statically — a call, not a module-scope const array. */}
      {fetchItems().map((item: { id: string; label: string }) => (
        <li key={item.id}>{item.label}</li>
      ))}

      {/* rule 5 (no-spread-props): an arbitrary prop bag. */}
      <div {...spreadProps} />

      {/* rule 6 (static-class-name): neither a literal string nor a
          styles.x member access — a plain const identifier. */}
      <div className={DANGER_CLASS}>Danger</div>

      {/* rule 9 (direct-component-imports): a tag with no import and no
          same-file declaration — untraceable to a local file or a package. */}
      <UndeclaredWidget />

      {/* rule 10 (no-wrapper-elements): a single-child wrapper that carries
          no attributes of its own. */}
      <div>
        <span>Wrapped</span>
      </div>
    </div>
  )
}
