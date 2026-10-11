/**
 * styleLanding — where a style edit LANDED (G-5), the one vocabulary the
 * server reports it in and the inspector's chip reads it from.
 *
 * A style edit never refuses; it takes the first honest rung of a ladder
 * (`docs/programs/refusals.md` R5), and the user is told which one:
 *
 *   - `rule`      — the class's own declaration: rewritten in place, or added
 *                   to its rule. "Saved in Card.module.css".
 *   - `expanded`  — a covering shorthand rewritten with that one side changed
 *                   (`padding: 4px 8px !important` -> `padding: 12px 8px 4px
 *                   !important`). "Saved in Card.css, shorthand expanded".
 *   - `override`  — a NEW declaration after the one it shadows, because the
 *                   winner could not be rewritten (an interpolation, a
 *                   shorthand, an `!important`). "Saved as an override in
 *                   Card.css".
 *   - `inline`    — the element's own `style=""`: the class cannot hold the
 *                   value (a compiled or unmapped class, a value a template
 *                   literal cannot spell).
 *
 * `expanded` and `override` rewrite bytes a plain "set the old value back"
 * does not restore, so the batch journals them (`styleLandingNeedsJournal`).
 *
 * `nodeId` is the join key the save already uses for the edit that landed: a
 * `css` edit's synthetic `css:<file>#<selector>#<atRule>#<property>`, a styled
 * edit's `rel:line:col` of its template tag, an inline edit's element id.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const StyleLandingRungSchema = Type.Union([
  Type.Literal('rule'),
  Type.Literal('expanded'),
  Type.Literal('override'),
  Type.Literal('inline'),
])

export type StyleLandingRung = Static<typeof StyleLandingRungSchema>

export const StyleLandingSchema = Type.Object({
  nodeId: Type.String(),
  rung: StyleLandingRungSchema,
  /** Workspace-relative path of the file the value was written into. */
  file: Type.String(),
})

export type StyleLanding = Static<typeof StyleLandingSchema>

/** True when a plain "write the previous value back" does not undo this landing byte for byte. */
export function styleLandingNeedsJournal(rung: StyleLandingRung): boolean {
  return rung === 'expanded' || rung === 'override'
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** The chip's sentence for a landing — what the inspector says in words. */
export function styleLandingText(landing: Pick<StyleLanding, 'rung' | 'file'>): string {
  const file = basename(landing.file)
  switch (landing.rung) {
    case 'rule':
      return `Saved in ${file}`
    case 'expanded':
      return `Saved in ${file}, shorthand expanded`
    case 'override':
      return `Saved as an override in ${file}`
    case 'inline':
      return 'Saved inline'
  }
}
