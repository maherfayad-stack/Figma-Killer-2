/**
 * styledRuleSources — the client's `StyleRule.id -> styled-component template`
 * registry (W4-4 Phase B), and the `kind: 'styled'` edit that registry makes
 * possible.
 *
 * The CSS-in-JS twin of `cssInsertDestination.ts`, and split off for the same
 * reason that module was split off `styleRuleWriteback.ts`: this file owns
 * WHERE a styled declaration is written, `styleRuleWriteback.ts` owns WHAT
 * changed since the last save, and `classNameWriteback.ts` needs the first
 * without the second (a styled class is not a token any `className` attribute
 * can carry — see `styledClassRefusal`).
 *
 * ## What Phase A left, and what this changes
 *
 * Phase A registers a styled template's CSS through `extraCss`, so its rules
 * arrive with an `sc-` id, `updatedAt: 0`, and NO `styleRuleSources` entry.
 * Everything read-only about a compiled rule then applied for free — the
 * "Style not saved to source" chip, the `unmapped` write-back refusal — which
 * was the right Phase A answer and the wrong permanent one: the declarations
 * ARE hand-authored, in a `.tsx` the user owns, three lines from where they
 * are looking.
 *
 * This map is what tells those two paths apart. A rule in it is writable for
 * VALUE edits (through `setStyledDeclaration`); a rule not in it is unmapped
 * exactly as before.
 *
 * ## Value edits, and nothing else
 *
 * There is deliberately no insert, no unset, and no class-token spelling here.
 *
 *   - **Adding or removing a declaration** means adding or deleting a line in
 *     a template the user wrote, around interpolations whose position decides
 *     what the CSS means. That is a restructuring edit, not the value edit the
 *     inspector's controls make.
 *   - **A class token** does not exist at all. The synthetic class is a HASH
 *     Studio computed (`syntheticClassName`); styled-components generates its
 *     own name at runtime and there is no `className` attribute in the `.tsx`
 *     holding either. Writing the hash into the JSX would produce markup that
 *     styles nothing outside Studio's own iframe — precisely the bug
 *     `style-02` fixed for CSS Modules, reachable again through this door.
 *     `styledClassRefusal` is the named decline; `classNameWriteback.ts` uses
 *     it before an edit is ever built.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * A `StyleRule.id`'s write-back target inside a styled template — the wire
 * shape of `server/handlers/studio/styledStyleRuleSources.ts`'s
 * `StyledStyleRuleSource`. `line`/`col` are the 1-based position of the
 * `styled.…`/`css` TAG, so `nodeId` below is an ordinary `rel:line:col` and
 * the server's location decoder, path guard, touched-file collection and
 * batch ordering all apply with no special case.
 */
export const StyledRuleSourceSchema = Type.Object({
  file: Type.String(),
  line: Type.Number(),
  col: Type.Number(),
  className: Type.String(),
  componentName: Type.String(),
})

export type StyledRuleSource = Static<typeof StyledRuleSourceSchema>

/** One `kind: 'styled'` edit, matching `server/handlers/studioEditSchemas.ts`'s `StyledEditSchema`. */
export interface StyledEditPayload {
  kind: 'styled'
  /** `rel:line:col` of the `styled.…` tag — a REAL source location, unlike a `css` edit's synthesized id. */
  nodeId: string
  className: string
  selector: string
  atMedia?: string
  property: string
  value: string
}

let styledRuleSources: Record<string, StyledRuleSource> = {}

/** The current workspace's `StyleRule.id -> styled template` map, from the last load. */
export function getStudioStyledRuleSources(): Record<string, StyledRuleSource> {
  return styledRuleSources
}

/** Replaces the whole registry — called once per load, through `setStudioStyleRuleSources`. */
export function replaceStyledRuleSources(sources: Record<string, StyledRuleSource>): void {
  styledRuleSources = sources
}

/** The `rel:line:col` a styled edit targets: the template's own tag position. */
export function styledEditNodeId(source: StyledRuleSource): string {
  return `${source.file}:${source.line}:${source.col}`
}

/**
 * Why a whole-class add/remove can never be written for a styled component,
 * as one sentence a person can act on.
 *
 * Named rather than inlined because two callers must say the same thing: the
 * class-token write-back (`classNameWriteback.ts`, which refuses the edit) and
 * anything that later wants to explain the same lock in the panel.
 */
export function styledClassRefusal(componentName: string): { reason: string; message: string } {
  return {
    reason: 'styled-component-class',
    message:
      `This class is ${componentName}'s own styling — styled-components generates its class name at runtime, so ` +
      'there is no class token in the source to add or remove. Edit the declarations inside the component instead, ' +
      'or change which component the element renders.',
  }
}
