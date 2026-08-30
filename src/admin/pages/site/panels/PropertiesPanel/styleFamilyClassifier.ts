/**
 * Which style family a rule belongs to — decided by what it DECLARES.
 *
 * `SectionStylesMenu` originally answered this from `rule.generated`, which
 * meant it only ever offered framework-generated utility classes. On a real
 * Studio project that is close to nothing: the source of truth is a React
 * repo, its style rules are parsed out of the project's own CSS by
 * `studioCss.ts`, and a parsed rule carries NO `generated` metadata because
 * nothing generated it. So a project with `.PlanCard_name { font-weight: 600 }`
 * and several hundred design-system classes opened the Text styles menu and
 * was told "no generated text styles yet" — technically true, useless, and
 * blaming a panel the user had no reason to visit.
 *
 * The repo is the document. A class the project already declares IS its text
 * style, and this module says so.
 *
 * ## Why "dominated by", not "mentions"
 *
 * CSS has no notion of a style's KIND, so any rule that happens to set
 * `color` would qualify as a colour style under a naive test — including
 * `.ESimActivation_frame`, which also sets `display`, `max-width` and
 * `background`. That is a component class, not a colour, and offering every
 * one of them would turn this menu back into the ClassPicker with a different
 * icon (the exact thing `SectionStylesMenu`'s doc warns against).
 *
 * So a rule qualifies for a family when **every property it declares belongs
 * to that family's vocabulary**, and at least one is the family's own core
 * property. `.PlanCard_name { font-weight }` is a text style;
 * `.ESimActivation_statusTime { font-size, font-weight, color }` is a text
 * style; `.ESimActivation_frame { display, max-width, font-family, color,
 * background }` is not, and stays reachable through the ClassPicker where a
 * whole-component class belongs.
 *
 * This is a heuristic about intent, and it is deliberately strict: a menu that
 * offers too much is worse than one that offers a little too little, because
 * the ClassPicker is always there as the complete list.
 */

import type { StyleRule } from '@core/page-tree'
import type { FrameworkColorUtilityType } from '@core/framework-schema'

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The properties a text style is allowed to touch. Wider than the "core" set
 * below because a real type style legitimately carries its own colour and its
 * own margins — `.lead { font-size; line-height; color; margin-bottom }` is
 * still a text style, and refusing it would be pedantry.
 */
const TEXT_VOCABULARY: ReadonlySet<string> = new Set([
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontFeatureSettings',
  'lineHeight', 'letterSpacing', 'wordSpacing',
  'textAlign', 'textDecoration', 'textDecorationColor', 'textDecorationLine',
  'textDecorationStyle', 'textDecorationThickness', 'textUnderlineOffset',
  'textTransform', 'textIndent', 'textShadow', 'textOverflow', 'textWrap',
  'whiteSpace', 'wordBreak', 'overflowWrap', 'hyphens', 'verticalAlign',
  'color', 'fontOpticalSizing', 'fontVariationSettings', 'fontStretch',
  'marginTop', 'marginBottom', 'marginBlockStart', 'marginBlockEnd',
])

/**
 * At least one of these must be present, or the rule is not a TYPE style —
 * it is something that merely happens to set a colour or a margin.
 */
const TEXT_CORE: ReadonlySet<string> = new Set([
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'lineHeight', 'letterSpacing', 'textTransform', 'textDecoration',
])

/** The property each colour family is actually about. */
const COLOR_CORE: Readonly<Record<FrameworkColorUtilityType, ReadonlyArray<string>>> = {
  text: ['color'],
  fill: ['fill', 'color'],
  background: ['background', 'backgroundColor', 'backgroundImage'],
  border: [
    'borderColor',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'outlineColor',
  ],
}

/**
 * What a colour style may declare besides its own colour. A design-system
 * colour class routinely ships its border width and style alongside the
 * colour (`.card-outline { border: 1px solid …}` parses into three
 * longhands), and splitting that hair would drop the classes people actually
 * reach for.
 */
const COLOR_COMPANIONS: ReadonlySet<string> = new Set([
  'borderStyle', 'borderWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'outlineStyle', 'outlineWidth', 'outlineOffset',
  'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundClip',
  'opacity',
])

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Every property a rule declares, base context only. */
function declaredProperties(rule: StyleRule): string[] {
  return Object.entries(rule.styles)
    .filter(([, value]) => value != null && value !== '')
    .map(([property]) => property)
}

/**
 * True when `rule` reads as a text style: it declares at least one core type
 * property and nothing outside the type vocabulary.
 *
 * A framework-generated typography class short-circuits to `true` — its own
 * metadata is authoritative and cheaper than inspecting declarations.
 */
export function isTextStyleRule(rule: StyleRule): boolean {
  if (rule.generated?.family === 'typography') return true
  if (rule.generated !== undefined) return false

  const declared = declaredProperties(rule)
  if (declared.length === 0) return false
  if (!declared.some((property) => TEXT_CORE.has(property))) return false
  return declared.every((property) => TEXT_VOCABULARY.has(property))
}

/**
 * True when `rule` reads as a colour style for one of `utilities`: it declares
 * at least one of that family's colour properties and nothing outside the
 * colour vocabulary.
 */
export function isColorStyleRule(
  rule: StyleRule,
  utilities: ReadonlyArray<FrameworkColorUtilityType>,
): boolean {
  const generated = rule.generated
  if (generated?.family === 'color') return utilities.includes(generated.utility)
  if (generated !== undefined) return false

  const core = new Set(utilities.flatMap((utility) => COLOR_CORE[utility]))
  const anyCore = new Set(
    (Object.keys(COLOR_CORE) as FrameworkColorUtilityType[]).flatMap((u) => COLOR_CORE[u]),
  )

  const declared = declaredProperties(rule)
  if (declared.length === 0) return false
  if (!declared.some((property) => core.has(property))) return false
  return declared.every(
    (property) => anyCore.has(property) || COLOR_COMPANIONS.has(property),
  )
}
