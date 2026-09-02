/**
 * cssPropertyIcons — the panel's picture vocabulary.
 *
 * Which CSS enums Figma draws instead of spelling out, which properties carry
 * their name as a glyph inside their own field, and which need no name at all
 * because their value already reads as one.
 *
 * Split out of `cssControlTypes` because it answers a different question. That
 * module maps a property to the KIND of control it needs (colour / select /
 * text) and to the framework scale behind it — facts about the value's type.
 * This one is about presentation: three hand-kept lists, each a judgement call
 * about legibility, that change when the panel's look changes rather than when
 * the CSS model does.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type { IconComponent } from 'pixel-art-icons/types'
import { UnderlineIcon } from 'pixel-art-icons/icons/underline'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import {
  TextAlignLeftIcon,
  TextAlignCenterIcon,
  TextAlignRightIcon,
  TextAlignJustifyIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  NoneSlashIcon,
  LineHeightIcon,
  LetterSpacingIcon,
  AspectRatioIcon,
  OpacityIcon,
} from '@ui/components/InspectorIcons'

// ---------------------------------------------------------------------------
// Icon enums — the enums Figma draws instead of spelling out
// ---------------------------------------------------------------------------

/**
 * One segment of an icon toggle group. Either a `icon` (the usual case) or a
 * short `label` for a value whose only honest picture is its own letterforms
 * — `AG` / `ag` / `Ag` for the three `text-transform` casings, which is what
 * Figma shows too.
 */
export interface IconEnumOption {
  value: string
  icon?: IconComponent
  label?: string
  /** Tooltip + accessible name. Always the plain-English value. */
  tooltip: string
}

/**
 * CSS enums rendered as an icon toggle group rather than a dropdown.
 *
 * This is the single biggest density lever in the panel and the reason the
 * label column could go: a dropdown reading "left" needs a "Text align" label
 * beside it to mean anything, and the pair eats a full row. Four bar-stack
 * glyphs in a 96px group need neither, and the current value is legible
 * without opening anything.
 *
 * Only enums with a genuinely readable picture are here. `display`,
 * `overflow`, `boxSizing`, `objectFit`, `cursor` and the rest keep their
 * dropdowns — inventing a glyph for `scale-down` would cost a click to
 * decode, which is the opposite of the point. `flexDirection`,
 * `justifyContent` and `alignItems` are absent for a different reason:
 * `LayoutSection` already draws them, direction-aware, in its own control.
 */
const ICON_ENUM_OPTIONS = new Map<keyof CSSPropertyBag, ReadonlyArray<IconEnumOption>>([
  ['textAlign', [
    { value: 'left',    icon: TextAlignLeftIcon,    tooltip: 'Align left' },
    { value: 'center',  icon: TextAlignCenterIcon,  tooltip: 'Align center' },
    { value: 'right',   icon: TextAlignRightIcon,   tooltip: 'Align right' },
    { value: 'justify', icon: TextAlignJustifyIcon, tooltip: 'Justify' },
  ]],
  ['fontStyle', [
    { value: 'normal', icon: NoneSlashIcon,   tooltip: 'Normal' },
    { value: 'italic', icon: TextItalicIcon,  tooltip: 'Italic' },
  ]],
  ['textDecoration', [
    { value: 'none',         icon: NoneSlashIcon,            tooltip: 'No decoration' },
    { value: 'underline',    icon: UnderlineIcon,            tooltip: 'Underline' },
    { value: 'line-through', icon: TextStrikethroughIcon,    tooltip: 'Strikethrough' },
  ]],
  ['textTransform', [
    { value: 'none',       icon: NoneSlashIcon, tooltip: 'As typed' },
    { value: 'uppercase',  label: 'AG',         tooltip: 'Uppercase' },
    { value: 'lowercase',  label: 'ag',         tooltip: 'Lowercase' },
    { value: 'capitalize', label: 'Ag',         tooltip: 'Capitalize' },
  ]],
])

/**
 * Returns the icon toggle group for a property, or undefined when the
 * property should keep its dropdown.
 */
export function getIconEnumOptions(
  prop: keyof CSSPropertyBag,
): ReadonlyArray<IconEnumOption> | undefined {
  return ICON_ENUM_OPTIONS.get(prop)
}

// ---------------------------------------------------------------------------
// In-field glyphs — the other half of "no label column"
// ---------------------------------------------------------------------------

/**
 * The mark a property carries INSIDE its input's leading edge, standing in
 * for the label that used to sit beside it. A letterform where one is
 * unambiguous (`W`, `H`, `X`), a drawn glyph where it isn't.
 *
 * A property with a glyph here renders with no visible label at all, so the
 * control MUST still receive the property's plain-English name as its
 * `aria-label` — this trades a visible label for a picture, not for silence.
 *
 * `SizeSection` and `PositionSection` pass their own `W`/`H`/`X`/`Y` prefixes
 * directly because their fields are bespoke; this map is for properties that
 * still go through the generic row.
 */
const PROPERTY_FIELD_GLYPHS = new Map<keyof CSSPropertyBag, IconComponent>([
  ['lineHeight', LineHeightIcon],
  ['letterSpacing', LetterSpacingIcon],
  ['aspectRatio', AspectRatioIcon],
  ['opacity', OpacityIcon],
  // Stacked boxes — `z-index` is depth, and it is the one Position field
  // whose number means nothing without saying which axis it is on.
  ['zIndex', BoxStackSolidIcon],
])

/** Returns the in-field glyph for a property, or undefined when it keeps a label. */
export function getPropertyFieldGlyph(
  prop: keyof CSSPropertyBag,
): IconComponent | undefined {
  return PROPERTY_FIELD_GLYPHS.get(prop)
}

/**
 * Properties whose control already reads as its own label inside a compact
 * paired grid, so a caption above it would say the same thing twice.
 *
 * "Bold" over a caption reading "Font weight" is noise; "nowrap" over a
 * caption reading "White space" is not, because the value alone is cryptic.
 * The distinction is judgement about each value's vocabulary, not a rule
 * about control types, which is why this is a hand-kept list rather than
 * `type === 'select'` — and it is exactly the set Figma leaves uncaptioned
 * in its own typography block.
 */
const SELF_DESCRIBING_PROPERTIES: ReadonlySet<keyof CSSPropertyBag> = new Set([
  'fontFamily',
  'fontWeight',
  'fontSize',
  // `border-box` / `content-box` say what they are. The caption above them
  // said it a second time and cost the Size section a whole row.
  'boxSizing',
  // A swatch plus its hex IS the label — this is Figma's fill row, which
  // carries no caption either. `background` (the shorthand) deliberately
  // keeps its caption: sitting under `backgroundColor` in the same section,
  // two uncaptioned colour-ish fields would be indistinguishable.
  'color',
  'backgroundColor',
])

/** True when a compact grid cell for `prop` should render with no caption. */
export function isSelfDescribingProperty(prop: keyof CSSPropertyBag): boolean {
  return SELF_DESCRIBING_PROPERTIES.has(prop)
}
