/**
 * variableKindsForProperty - which kinds of project variable a STYLE property
 * can legally take, for the plain text fields that have no kinds of their own.
 *
 * Colour fields (`TokenizedColorField`) and the length scrubbers (`ScrubInput`,
 * `TokenAwareInput`) already declare their kinds. What was left were the
 * typographic and effect fields drawn as plain text - `letter-spacing`,
 * `box-shadow`, `transition-duration` - and the font-family picker. A field
 * that offered the wrong kind would write `box-shadow: var(--color-brand)`, a
 * declaration the browser drops, so the map is explicit and a property that is
 * not listed gets no affordance rather than a guess.
 */
import {
  DURATION_VARIABLE_KINDS,
  FONT_FAMILY_VARIABLE_KINDS,
  LENGTH_VARIABLE_KINDS,
  SHADOW_VARIABLE_KINDS,
  type VariableKind,
} from '@ui/components/VariableField'

const LENGTH_OR_NUMBER = LENGTH_VARIABLE_KINDS

const KINDS_BY_PROPERTY: Readonly<Record<string, readonly VariableKind[]>> = {
  fontFamily: FONT_FAMILY_VARIABLE_KINDS,
  fontSize: LENGTH_OR_NUMBER,
  lineHeight: LENGTH_OR_NUMBER,
  letterSpacing: LENGTH_OR_NUMBER,
  wordSpacing: LENGTH_OR_NUMBER,
  textIndent: LENGTH_OR_NUMBER,
  boxShadow: SHADOW_VARIABLE_KINDS,
  textShadow: SHADOW_VARIABLE_KINDS,
  transitionDuration: DURATION_VARIABLE_KINDS,
  transitionDelay: DURATION_VARIABLE_KINDS,
  animationDuration: DURATION_VARIABLE_KINDS,
  animationDelay: DURATION_VARIABLE_KINDS,
}

/** The kinds the property's text field accepts, or `undefined` when it takes no variable. */
export function variableKindsForProperty(property: string): readonly VariableKind[] | undefined {
  return KINDS_BY_PROPERTY[property]
}
