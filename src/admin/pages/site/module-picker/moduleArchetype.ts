/**
 * moduleArchetype — a wireframe for a module that has no hand-drawn entry in
 * `MODULE_WIRES`, derived from what the module itself declares.
 *
 * ## The problem this solves
 *
 * `MODULE_WIRES` is a hand-authored map of 25 `base.*` ids. Everything else
 * fell through `moduleWireForId`'s category guess to `base.container` — an
 * empty dashed box. In a real Studio project that is nearly the entire picker:
 * on a design-system project, 44 of 46 modules are package components, and all
 * of them drew the SAME empty rectangle. Accolade, Badge, BottomActionBar and
 * Button were pixel-identical, so the preview told an author nothing that the
 * name underneath it had not already said.
 *
 * Extending the hand-authored map was the obvious fix and the wrong one. It
 * only ever covers packages someone has drawn by hand, and Studio's whole
 * premise is the design system in the user's OWN repo. `packageManifest.ts`
 * already calls the build-time ALM manifest "the one thing that never
 * generalized"; a second hardcoded list would be the same mistake.
 *
 * ## What it derives from
 *
 * Every `ModuleDefinition` carries `schema`, a `Record<propName,
 * PropertyControl>` — which is real, per-component data that already exists
 * for any package, first-party or imported. Two layers, in order:
 *
 * 1. **Name archetypes.** A component called `BottomSheet`, `Badge` or
 *    `Checkbox` has a shape everyone already pictures, and its prop list often
 *    does not say so (a `Badge` and a `Chip` are both `{label, size}`). These
 *    are matched on the component's own name, never on a package id, so they
 *    work identically for `alm.Badge` and any other design system's `Badge`.
 *
 * 2. **Prop-shape sketch.** Otherwise, draw one primitive per declared prop:
 *    a `text` control is a line, an `image` an image block, a `toggle` a
 *    checkmark, a `select` a field with a caret, a `slot` a dashed well. Two
 *    components with different APIs then look different, which is the whole
 *    point, and nothing had to be authored per component.
 *
 * The last resort is a single centred glyph rather than an empty box — that is
 * the honest picture of a leaf with no editable props (every `*Icon` export),
 * and it still reads as "different from a container".
 *
 * ## What this is not
 *
 * It is a sketch derived from an API, not a rendering. It cannot know that
 * `Callout` is orange, and a `Badge` and a `Tag` with identical props will
 * still look alike. Rendering the real component is a separate, Tier-1 piece
 * of work — this layer is what every project gets with no execution, at Tier 0,
 * offline, and instantly.
 */
import type { PropertySchema } from '@core/module-engine'
import {
  box,
  button,
  check,
  col,
  dot,
  field,
  icon,
  image,
  lines,
  radio,
  row,
  rule,
  type WireNode,
} from './wireNode'

/** The subset of a `ModuleDefinition` this derivation reads. */
export interface ArchetypeInput {
  /** The component's own name (`Badge`), never the module id — so a name rule fires for any package's `Badge`. */
  name: string
  /** `ModuleDefinition.schema` — prop key to control descriptor. */
  schema?: PropertySchema
}

// ---------------------------------------------------------------------------
// Layer 1 — name archetypes
// ---------------------------------------------------------------------------

/**
 * Ordered most- to least- specific: the FIRST pattern that matches wins, so a
 * `BottomActionBar` must be tested before the generic `Bar`, and `TextInput`
 * before `Text`. Every pattern is anchored on a whole word so `Tag` does not
 * fire for `TagLine` and `Bar` does not fire for `Banner`.
 */
const NAME_ARCHETYPES: readonly (readonly [RegExp, () => WireNode])[] = [
  // FIRST, always. An `*Icon` export is a leaf glyph, and the word in front of
  // `Icon` is not a description of its shape: `CheckboxCheckedIcon` matched
  // `/checkbox/` and drew a two-row checkbox list, `RadioButtonIcon` drew a
  // radio group. Measured in the picker — those two rules were producing three
  // identical thumbnails each, for things that render as a single glyph.
  [/icon$/i, () => row([icon({ big: true })], { center: true, align: 'center', height: 44 })],

  // Overlays — a panel over a dimmed screen, which is the one thing that
  // makes them recognisable at thumbnail size.
  [/sheet|drawer/i, () => col([box([], { height: 14, dashed: true }), box([lines(1, { width: 24, center: true }), lines(2), button({ width: 44, solid: true })], { card: true, pad: 6, gap: 5 })], { gap: 4 })],
  [/dialog|modal|popup|alert/i, () => box([lines(1, { width: 40, center: true, big: true }), lines(2), row([button({ width: 30 }), button({ width: 30, solid: true })], { gap: 5, center: true })], { card: true, pad: 7, gap: 5, center: true })],
  [/tooltip|popover/i, () => col([box([lines(1, { width: 40 })], { card: true, pad: 5, tip: true }), row([button({ width: 26 })], { center: true })], { gap: 5, center: true })],

  // Bars and navigation.
  [/navbar|appbar|topbar|header/i, () => row([icon(), lines(1, { flex: 1, width: 30 }), icon()], { card: true, pad: 6, gap: 6, align: 'center' })],
  [/tabbar|bottomactionbar|footer|actionbar/i, () => row([col([icon(), lines(1, { width: 14 })], { gap: 3, center: true }), col([icon(), lines(1, { width: 14 })], { gap: 3, center: true }), col([icon(), lines(1, { width: 14 })], { gap: 3, center: true })], { card: true, pad: 6, gap: 10, center: true })],
  [/segmentedcontrol|tabs|toggle ?group/i, () => row([button({ flex: 1, solid: true }), button({ flex: 1 }), button({ flex: 1 })], { card: true, pad: 3, gap: 3 })],

  // Feedback and status strips.
  [/(?<!ad)banner|callout|snackbar|toast|notice|message/i, () => box([row([icon(), col([lines(1, { width: 34 }), lines(1)], { gap: 3, flex: 1 })], { gap: 6, align: 'center' })], { message: true, pad: 6 })],
  [/badge|tag|chip|pill|label/i, () => row([button({ width: 34 })], { align: 'center', center: true, height: 40 })],
  [/accolade|rating|review/i, () => row([dot(), dot(), dot(), lines(1, { width: 22 })], { gap: 4, align: 'center' })],

  // Progress and steppers.
  [/circularprogress|spinner|loader/i, () => row([icon({ big: true })], { center: true, align: 'center', height: 44 })],
  [/slider/i, () => col([lines(1, { width: 26 }), row([box([], { bar: true, flex: 1, height: 6 }), dot()], { gap: 4, align: 'center' })], { gap: 6 })],
  [/progress|stepper/i, () => col([lines(1, { width: 26 }), box([], { bar: true, height: 6 })], { gap: 6 })],

  // Disclosure.
  [/accordion|expander|collaps|disclosure/i, () => col([row([lines(1, { flex: 1, width: 40 }), icon()], { gap: 6, align: 'center' }), rule(), row([lines(1, { flex: 1, width: 30 }), icon()], { gap: 6, align: 'center' })], { gap: 6 })],

  // Form controls — before the generic text rules.
  [/checkbox/i, () => col([row([check(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }), row([check(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })], { gap: 6 })],
  [/radio/i, () => col([row([radio(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }), row([radio(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })], { gap: 6 })],
  [/switch|toggle/i, () => row([lines(1, { flex: 1, width: 30 }), button({ width: 20, solid: true })], { gap: 6, align: 'center' })],
  [/textinput|textarea|textfield/i, () => col([lines(1, { width: 26 }), field({ height: 26, caret: true })], { gap: 4 })],
  [/search/i, () => row([icon(), lines(1, { flex: 1 })], { card: true, pad: 6, gap: 6, align: 'center' })],
  [/input|field|picker|dropdown|select/i, () => col([lines(1, { width: 26 }), field({ caret: true })], { gap: 4 })],
  [/button|cta/i, () => row([button({ width: 48, solid: true })], { center: true, align: 'center', height: 40 })],

  // Content blocks.
  [/visualcard|marketingcard|adbanner|card/i, () => col([image({ height: 26 }), lines(1, { width: 40, big: true }), lines(2)], { gap: 5 })],
  [/listitem|cell|row(?!s)/i, () => row([image({ width: 18, height: 18, avatar: true }), col([lines(1, { width: 36 }), lines(1, { width: 24 })], { gap: 3, flex: 1 }), icon()], { gap: 6, align: 'center' })],
  [/list|menu/i, () => col([row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }), row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }), row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })], { gap: 6 })],
  [/logo|brand/i, () => row([icon({ big: true, logo: true })], { center: true, align: 'center', height: 44 })],
  [/avatar|profile/i, () => row([image({ width: 30, height: 30, avatar: true })], { center: true, align: 'center', height: 44 })],
  [/image|photo|thumbnail|illustration/i, () => image({ height: 48 })],
  [/video|player/i, () => image({ height: 48, play: true })],
  [/separator|divider|rule/i, () => col([lines(1), rule(), lines(1)], { gap: 8 })],
  [/heading|title/i, () => lines(1, { big: true, width: 52 })],
  [/text|paragraph|body/i, () => lines(3)],
]

function nameArchetype(name: string): WireNode | undefined {
  for (const [pattern, build] of NAME_ARCHETYPES) {
    if (pattern.test(name)) return build()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Layer 2 — prop-shape sketch
// ---------------------------------------------------------------------------

/** One wire primitive per control type. `undefined` for controls that describe no visible content (identifier, group, layout). */
function wireForControl(controlType: string, propName: string): WireNode | undefined {
  switch (controlType) {
    case 'image':
    case 'media':
      return image({ height: 24 })
    case 'video':
      return image({ height: 24, play: true })
    case 'svg':
      return row([icon({ big: true })], { center: true })
    case 'toggle':
      return row([check(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })
    case 'select':
      return field({ caret: true })
    case 'color':
    case 'hex':
    case 'rgba':
      return row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })
    case 'slot':
      return box([], { dashed: true, height: 22 })
    case 'textarea':
    case 'richtext':
    case 'content':
      return lines(3)
    case 'number':
      return row([lines(1, { width: 20 }), field({ width: 26 })], { gap: 6, align: 'center' })
    case 'url':
      return lines(1, { link: true, width: 44 })
    case 'text':
      // A prop literally named for the component's main label reads as a
      // heading; anything else is body copy.
      return /title|heading|label|name/i.test(propName) ? lines(1, { big: true, width: 46 }) : lines(1)
    default:
      return undefined
  }
}

/** How many prop rows a thumbnail can carry before it turns to mush. */
const MAX_SKETCH_ROWS = 4

function propShapeSketch(schema: PropertySchema | undefined): WireNode | undefined {
  if (!schema) return undefined
  const rows: WireNode[] = []
  for (const [propName, control] of Object.entries(schema)) {
    if (rows.length >= MAX_SKETCH_ROWS) break
    const controlType = (control as { type?: string } | undefined)?.type
    if (!controlType) continue
    const wire = wireForControl(controlType, propName)
    if (wire) rows.push(wire)
  }
  if (rows.length === 0) return undefined
  return col(rows, { gap: 6 })
}

// ---------------------------------------------------------------------------

/** A leaf with no editable props and no name we recognise — an icon-like glyph, never an anonymous empty box. */
const LEAF_GLYPH: WireNode = row([icon({ big: true })], { center: true, align: 'center', height: 44 })

/**
 * The best wireframe derivable for `mod`, or `undefined` when there is genuinely
 * nothing to go on (which callers render as their own container fallback).
 */
export function archetypeWire(mod: ArchetypeInput): WireNode {
  return nameArchetype(mod.name) ?? propShapeSketch(mod.schema) ?? LEAF_GLYPH
}
