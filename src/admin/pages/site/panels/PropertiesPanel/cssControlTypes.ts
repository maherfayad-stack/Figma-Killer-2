/**
 * cssControlTypes — centralized CSS property → UI control-type mapping.
 *
 * Determines which widget renders each CSS property in the unified
 * property-editing surface (ClassPropertyRow + Module section rows).
 *
 * Phase 3 / Task #464 / Spec #671.
 * Co-locates with PropertiesPanel per §6 of Spec #671.
 */

import type { CSSPropertyBag } from '@core/page-tree'
// The curated-property set below is derived from the section registry,
// which now lives in its own module — see that file's header for why.
import { CLASS_STYLE_SECTIONS } from './classStyleSections'
import { hasStyleValue } from './styleValueUtils'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type CSSControlType = 'color' | 'select' | 'text'

/**
 * Which framework variable scale (if any) backs autocomplete suggestions
 * for a CSS property. The string identifies the Token catalog the
 * `TokenAwareInput` should pull from. Returning undefined means the
 * property uses a plain text/select/color control with no token suggestions.
 *
 * The mapping is intentionally narrow — a property only earns a token source
 * when the framework's vocabulary is genuinely the right answer for that
 * value type. Lengths in container-only / item-only contexts that already
 * have dedicated visual blocks (gap inside flex/grid blocks, top/right/
 * bottom/left inside the position block, padding/margin inside
 * SpacingBoxControl) are not in this map because their visual blocks
 * already wire token suggestions in directly.
 */
type CSSPropertyTokenSource = 'spacing' | 'typography'

// ---------------------------------------------------------------------------
// CSSPropertyBag keys whose store type is `number`, not `string`.
// ClassPropertyRow still renders these as text inputs, then coerces valid values to numbers.
// ---------------------------------------------------------------------------

export const NUMBER_TYPED_PROPS = new Set<keyof CSSPropertyBag>(['zIndex', 'opacity'])

// ---------------------------------------------------------------------------
// Color properties
// ---------------------------------------------------------------------------

const COLOR_PROPERTIES = new Set<keyof CSSPropertyBag>([
  'color',
  'backgroundColor',
  // Per-side border colors land here too so they render with the colour
  // picker when surfaced in advanced-mode rows. The BorderControl
  // composite uses its own picker; this fallback only matters when the
  // user opens the unified property surface that lists every key.
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
])

// ---------------------------------------------------------------------------
// Border style keywords — used by the visual BorderControl and the
// fallback property surface.
// ---------------------------------------------------------------------------
const BORDER_STYLE_KEYWORDS = [
  'none', 'hidden', 'solid', 'dashed', 'dotted', 'double',
  'groove', 'ridge', 'inset', 'outset',
]

// ---------------------------------------------------------------------------
// mix-blend-mode keywords — grouped exactly as Figma's F12 blend-mode menu
// groups them (Normal, then the darken/lighten/contrast/difference/colour
// families). `AppearanceSection`'s droplet menu renders the grouped form;
// this flat list backs the enum dispatch / search / fallback paths.
// ---------------------------------------------------------------------------
const BLEND_MODE_KEYWORDS = [
  'normal',
  'darken', 'multiply', 'color-burn',
  'lighten', 'screen', 'color-dodge',
  'overlay', 'soft-light', 'hard-light',
  'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
]

// ---------------------------------------------------------------------------
// Enum (select) properties → option lists (first option is the default)
// ---------------------------------------------------------------------------

const ENUM_OPTIONS = new Map<keyof CSSPropertyBag, string[]>([
  ['display',          ['block', 'inline', 'inline-block', 'flex', 'grid', 'none']],
  ['flexDirection',    ['row', 'column', 'row-reverse', 'column-reverse']],
  ['flexWrap',         ['nowrap', 'wrap', 'wrap-reverse']],
  ['alignItems',       ['flex-start', 'flex-end', 'center', 'stretch', 'baseline']],
  ['justifyContent',   ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly']],
  ['justifyItems',     ['stretch', 'start', 'center', 'end']],
  ['alignSelf',        ['auto', 'flex-start', 'flex-end', 'center', 'stretch']],
  ['justifySelf',      ['auto', 'flex-start', 'flex-end', 'center', 'stretch']],
  ['fontStyle',        ['normal', 'italic']],
  ['fontWeight',       ['300', '400', '500', '600', '700', 'bold', 'normal']],
  ['textAlign',        ['left', 'center', 'right', 'justify']],
  ['textTransform',    ['none', 'uppercase', 'lowercase', 'capitalize']],
  ['whiteSpace',       ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']],
  ['textDecoration',   ['none', 'underline', 'line-through', 'overline']],
  ['boxSizing',        ['border-box', 'content-box']],
  ['position',         ['static', 'relative', 'absolute', 'fixed', 'sticky']],
  ['overflow',         ['visible', 'hidden', 'scroll', 'auto']],
  ['overflowX',        ['visible', 'hidden', 'scroll', 'auto']],
  ['overflowY',        ['visible', 'hidden', 'scroll', 'auto']],
  ['backgroundRepeat', ['no-repeat', 'repeat', 'repeat-x', 'repeat-y']],
  ['objectFit',        ['cover', 'contain', 'fill', 'none', 'scale-down']],
  ['pointerEvents',    ['auto', 'none']],
  ['scrollBehavior',   ['auto', 'smooth']],
  ['cursor',           ['auto', 'pointer', 'default', 'move', 'not-allowed', 'crosshair', 'text']],
  // Border styles — the visual BorderControl uses the same list directly.
  ['borderStyle',      BORDER_STYLE_KEYWORDS],
  ['borderTopStyle',   BORDER_STYLE_KEYWORDS],
  ['borderRightStyle', BORDER_STYLE_KEYWORDS],
  ['borderBottomStyle',BORDER_STYLE_KEYWORDS],
  ['borderLeftStyle',  BORDER_STYLE_KEYWORDS],
  // Native form-control appearance — only `none` and `auto` see real-world use.
  ['appearance',       ['auto', 'none']],
  ['visibility',       ['visible', 'hidden', 'collapse']],
  ['mixBlendMode',     BLEND_MODE_KEYWORDS],
  // Animation longhands (W5-5). The Animations section gives each of these a
  // typed control of its own; these entries are for the OTHER doors into the
  // same property — a style search that surfaces it, and the generic fallback
  // row. `animationTimingFunction` is deliberately absent: its value set is
  // open (`cubic-bezier()`, `steps()`, `linear()`), so a select would be a
  // lie that silently discards a custom curve. It stays a text control here,
  // and the section's own editor offers presets alongside a curve field.
  ['animationDirection', ['normal', 'reverse', 'alternate', 'alternate-reverse']],
  ['animationFillMode',  ['none', 'forwards', 'backwards', 'both']],
  ['animationPlayState', ['running', 'paused']],
])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the UI control type for a given CSS property key.
 * Dispatch order: color → select → text (fallback).
 */
export function getCSSPropertyControlType(prop: keyof CSSPropertyBag): CSSControlType {
  if (COLOR_PROPERTIES.has(prop)) return 'color'
  if (ENUM_OPTIONS.has(prop))     return 'select'
  return 'text'
}

/** Returns the enum option list for a select property, or undefined if not an enum. */
export function getEnumOptions(prop: keyof CSSPropertyBag): string[] | undefined {
  return ENUM_OPTIONS.get(prop)
}


/**
 * Per-property mapping to the framework variable scale that backs its
 * autocomplete dropdown. Properties absent from this map render with
 * plain text inputs (no token suggestions).
 *
 * Currently surfaces typography variables for `fontSize`. Other typography
 * properties (lineHeight, letterSpacing) deliberately keep plain text
 * inputs because they accept unitless / em / px values that don't map to
 * a single fluid scale.
 */
const PROPERTY_TOKEN_SOURCES = new Map<keyof CSSPropertyBag, CSSPropertyTokenSource>([
  ['fontSize', 'typography'],
])

/** Returns the framework token source for a property, or undefined when none applies. */
export function getCSSPropertyTokenSource(
  prop: keyof CSSPropertyBag,
): CSSPropertyTokenSource | undefined {
  return PROPERTY_TOKEN_SOURCES.get(prop)
}

/**
 * Properties whose value is a plain CSS length, where arrow-key nudging makes
 * sense and an empty field should start from `0px`. Excludes props with
 * special value spaces that a fixed 1/8/0.1 length step would mishandle —
 * `opacity`/`zIndex` (unitless ratios/integers), `aspectRatio` (`16/9`),
 * grid templates, `flex`, `transform`, shadows, etc. `fontSize` is absent
 * here because it nudges through its token-aware input instead.
 */
const LENGTH_NUDGE_PROPS = new Set<keyof CSSPropertyBag>([
  // Size
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  // Position insets
  'top', 'right', 'bottom', 'left',
  // Layout gaps
  'gap', 'rowGap', 'columnGap',
  // Spacing longhands
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  // Typography lengths
  'lineHeight', 'letterSpacing',
  // Border widths + radii + outline
  'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius',
  'outlineOffset',
])

/** True when `prop` is a plain-length property eligible for arrow-key nudging. */
export function isLengthNudgeProp(prop: keyof CSSPropertyBag): boolean {
  return LENGTH_NUDGE_PROPS.has(prop)
}

/**
 * Per-property default values for the add-property search.
 *
 * Implements the per-property lookup table from UX Reviewer Contribution #677 (accepted,
 * Architect msg #2080). Control-type dispatch was NOT used because many CSS properties
 * have non-trivial defaults that the broad bucket approach gets wrong:
 *   - opacity: should be 1 (fully visible), not 0 (invisible)
 *   - zIndex:  should be 0 (neutral), not -10
 *   - width:   should be 'auto' (layout-safe), not '0px'
 *   - maxWidth: should be 'none' (unconstrained), not '0px'
 *   - borderWidth: see border shorthands below — shorthand left empty for manual entry
 *
 * Section order mirrors ALL_CSS_PROPERTIES for visual diff-ability.
 *
 * Note on NUMBER_TYPED_PROPS (zIndex, opacity): CSSPropertyBag types these as `number`,
 * so their defaults must be numbers, not strings ('auto' / '1' would fail TS types).
 */
const DEFAULT_CSS_VALUES: Partial<Record<keyof CSSPropertyBag, string | number>> = {
  // ── Typography ───────────────────────────────────────────────────────────
  fontFamily:     'inherit',  // inheriting keeps text legible; '#000' would override cascade
  fontSize:       '14px',
  fontWeight:     '400',
  fontStyle:      'normal',
  letterSpacing:  '0px',
  lineHeight:     '1.5',      // unitless — NOT '1.5px'; couples to fontSize correctly
  textAlign:      'left',
  textDecoration: 'none',
  textTransform:  'none',
  whiteSpace:     'normal',
  color:          'inherit',  // NOT '#000000' — inheriting keeps text legible by default
  textShadow:     'none',
  // ── Layout ───────────────────────────────────────────────────────────────
  display:             'block',
  flexDirection:       'row',
  flexWrap:            'nowrap',
  alignItems:          'stretch',
  justifyContent:      'flex-start',
  justifyItems:        'stretch',
  alignSelf:           'auto',
  justifySelf:         'auto',
  flex:                '0 1 auto', // matches browser default (flex-grow:0; flex-shrink:1; basis:auto)
  gap:                 '0',
  rowGap:              '0',
  columnGap:           '0',
  gridTemplateColumns: 'none',
  gridTemplateRows:    'none',
  gridColumn:          'auto',
  gridRow:             'auto',
  // ── Size ─────────────────────────────────────────────────────────────────
  width:     'auto',   // NOT '100px' — auto avoids surprising layout shifts on add
  height:    'auto',
  minWidth:  '0px',
  maxWidth:  'none',   // 'none' = unconstrained; NOT a px value that incorrectly constrains
  minHeight: '0px',
  maxHeight: 'none',
  aspectRatio: '',     // free-form text (e.g. "16/9"); no sensible universal default
  boxSizing:   'border-box',
  // ── Spacing ───────────────────────────────────────────────────────────────
  // Per-side only — see CSSPropertyBagSchema for the rationale (publisher
  // collapses 4 sides into the CSS shorthand at emission time).
  paddingTop:    '0px',
  paddingRight:  '0px',
  paddingBottom: '0px',
  paddingLeft:   '0px',
  marginTop:     '0px',
  marginRight:   '0px',
  marginBottom:  '0px',
  marginLeft:    '0px',
  // ── Position ──────────────────────────────────────────────────────────────
  position: 'static',
  top:      'auto',    // NOT '0px' — 0px would immediately reposition positioned elements
  right:    'auto',
  bottom:   'auto',
  left:     'auto',
  zIndex:   0,         // number (CSSPropertyBag.zIndex?: number); 0 is neutral stacking
  // ── Visual ────────────────────────────────────────────────────────────────
  backgroundColor:   'transparent', // NOT '#000000' — transparent is a safe no-op
  background:        '',             // shorthand — left empty for manual entry
  backgroundImage:   'none',
  backgroundSize:    'auto',
  backgroundPosition:'0% 0%',
  backgroundRepeat:  'repeat',
  objectFit:         'cover',
  objectPosition:    'center center',
  opacity:           1,              // number (CSSPropertyBag.opacity?: number); 1 = fully opaque
  overflow:          'visible',
  overflowX:         'visible',
  overflowY:         'visible',
  visibility:        'visible',
  mixBlendMode:      'normal',
  // ── Border ────────────────────────────────────────────────────────────────
  border:       '',    // shorthands left empty — user specifies manually (e.g. "1px solid red")
  borderTop:    '',
  borderRight:  '',
  borderBottom: '',
  borderLeft:   '',
  // 4-sides shorthand longhands. Empty placeholders so the publisher
  // doesn't accidentally emit `border-width: 0` etc. when the user only
  // touched the per-side longhands.
  borderWidth: '',
  borderStyle: '',
  borderColor: 'transparent',
  // Per-side longhands edited by the visual BorderControl.
  borderTopWidth:    '0',
  borderTopStyle:    'none',
  borderTopColor:    'transparent',
  borderRightWidth:  '0',
  borderRightStyle:  'none',
  borderRightColor:  'transparent',
  borderBottomWidth: '0',
  borderBottomStyle: 'none',
  borderBottomColor: 'transparent',
  borderLeftWidth:   '0',
  borderLeftStyle:   'none',
  borderLeftColor:   'transparent',
  borderRadius:            '0px',
  borderTopLeftRadius:     '0px',
  borderTopRightRadius:    '0px',
  borderBottomLeftRadius:  '0px',
  borderBottomRightRadius: '0px',
  outline:       'none',
  outlineOffset: '0px',
  // ── Form-control reset ────────────────────────────────────────────────────
  appearance: 'auto',
  // ── Effects ───────────────────────────────────────────────────────────────
  boxShadow:      'none',
  filter:         'none',
  backdropFilter: 'none',
  transform:      'none',
  transformOrigin:'50% 50%',  // centre origin — corner '0 0' surprises users rotating/scaling
  // ── Motion ────────────────────────────────────────────────────────────────
  transition: 'none',
  animation:  'none',
  // ── Interaction ───────────────────────────────────────────────────────────
  cursor:        'default',
  pointerEvents: 'auto',
  userSelect:    'auto',
  // ── Scrollbar ─────────────────────────────────────────────────────────────
  scrollBehavior: 'auto',
}

/**
 * Returns the initial value to use when adding a CSS property via search.
 *
 * Uses the per-property lookup table (DEFAULT_CSS_VALUES) from Contribution #677.
 * Falls back to control-type dispatch for any future CSSPropertyBag additions not yet
 * in the table — keeps add-property search functional even before the table is updated.
 */
export function getCSSPropertyDefaultValue(prop: keyof CSSPropertyBag): string | number {
  const tableVal = DEFAULT_CSS_VALUES[prop]
  if (tableVal !== undefined) return tableVal

  // Fallback: control-type dispatch for future properties not yet in DEFAULT_CSS_VALUES.
  // Add new CSSPropertyBag keys to the table above before shipping to avoid this path.
  const type = getCSSPropertyControlType(prop)
  if (type === 'select') return ENUM_OPTIONS.get(prop)?.[0] ?? ''
  return ''
}

/**
 * Convert a camelCase CSS property key to a human-readable label.
 * e.g. 'paddingTop' → 'Padding top', 'backgroundColor' → 'Background color'
 */
export function cssPropertyLabel(prop: string): string {
  const spaced = prop.replace(/([A-Z])/g, ' $1').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}


// ---------------------------------------------------------------------------
// Custom properties — the long tail of CSS the curated sections don't claim
// ---------------------------------------------------------------------------

/**
 * Every property claimed by a curated style section. Anything a rule has set
 * that is NOT in this set is "custom" — surfaced in the generic Custom
 * properties editor (Phase 1b of the CSS fidelity plan). Includes the Border
 * Advanced shorthands and per-side longhands the visual controls own, so they
 * never double-appear in Custom.
 */
const CLAIMED_PROPERTIES: ReadonlySet<string> = new Set(
  CLASS_STYLE_SECTIONS.flatMap((section) => section.properties.map((p) => String(p))),
)

/**
 * Whether a property is claimed by a curated section (and therefore must NOT
 * appear in the Custom properties editor).
 */
export function isCuratedProperty(prop: string): boolean {
  return CLAIMED_PROPERTIES.has(prop)
}

/**
 * The set-but-uncurated property keys of a style bag, sorted for stable
 * display order. These are the rows the Custom properties editor renders:
 * imported exotica (`gridAutoFlow`) and any `--custom-property`, editable as
 * raw key/value pairs.
 */
export function getCustomProperties(storedStyles: Record<string, unknown>): string[] {
  return Object.keys(storedStyles)
    .filter((key) => hasStyleValue(storedStyles[key]) && !isCuratedProperty(key))
    .sort()
}

// ---------------------------------------------------------------------------
// Track F1 — every curated property, flattened and deduped
//
// The full set of CSS properties the panel curates a control for, in ONE
// frozen module-level array. Used to ask the frame (`useFrameComputedStyleValues`)
// for the real `getComputedStyle` value of every row the panel can show, so
// the "unset" placeholder can be ground truth instead of a guess — see
// `stylePropertyProvenance.ts`'s module doc for the fuller story. Frozen and
// built once at module scope (not per-render) per the selector-stability
// convention for reference-stable arrays passed into hooks.
// ---------------------------------------------------------------------------

export const ALL_CURATED_CSS_PROPERTIES: ReadonlyArray<string> = Object.freeze([
  ...new Set(CLASS_STYLE_SECTIONS.flatMap((section) => section.properties.map((p) => String(p)))),
])
