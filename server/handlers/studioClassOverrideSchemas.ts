/**
 * The wire shape of the two edits behind a per-instance CLASS override (G-2b),
 * apart from `studioClassOverride.ts` so the edit union can import them without
 * the module that applies them (and the refusals it throws) closing a cycle.
 */
import { AT_RULE_SCOPE_PATTERN } from '@core/css-codemods'
import { Type } from '@core/utils/typeboxHelpers'

const AtRule = Type.String({ pattern: AT_RULE_SCOPE_PATTERN })

/**
 * "Change this class's declarations for ONE instance of the component": the
 * root element of the instance (`nodeId`, inlined: `page~component:line:col`, or
 * one more segment per component that only passes its props on) takes a
 * modifier class from its call site, and the new declarations are written to a
 * rule one class more specific than the class's own (`.card.card-home-2`).
 *
 * `file` + `selector` name the rule being edited, as the load reported it
 * (`styleRuleSources`): the component's own class (`.card`), or the instance's
 * modifier when it already has one. Neither is trusted: the server checks the
 * stylesheet is a writable `.css` inside the project, that the instance's root
 * really names the class, and re-reads everything else from disk.
 * `declarations` are kebab-case property → value. Journaled; ⌘Z is `restore`.
 */
export const ExposeClassEditSchema = Type.Object({
  kind: Type.Literal('expose-class'),
  nodeId: Type.String(),
  file: Type.String(),
  selector: Type.String(),
  declarations: Type.Record(Type.String({ pattern: '^[a-z-]+$', maxLength: 64 }), Type.String({ maxLength: 2_000 }), { minProperties: 1, maxProperties: 32 }),
  atRule: Type.Optional(AtRule),
})

/**
 * "Apply to all (N)" for a class override: the instance's modifier rule hands
 * `properties` to the component's own rule (`selector`, the base), and the
 * modifier — the class on the call site and its rule — goes once it is empty.
 * `nodeId` is any element of the instance, addressed like `expose-class`'s.
 * Journaled; ⌘Z is `restore`.
 */
export const PromoteClassOverrideEditSchema = Type.Object({
  kind: Type.Literal('promote-class-override'),
  nodeId: Type.String(),
  file: Type.String(),
  selector: Type.String(),
  properties: Type.Array(Type.String({ pattern: '^[a-z-]+$', maxLength: 64 }), { minItems: 1, maxItems: 32 }),
  atRule: Type.Optional(AtRule),
})
