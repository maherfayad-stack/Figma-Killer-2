/**
 * backgroundLayers — pure parse/serialise for the CSS `background-*` layer
 * stack (docs/features/inspector-disclosure.md §4 G6.5).
 *
 * THE MODEL
 * ---------
 * `background-image` is a comma-separated LIST of paint layers, first =
 * TOPMOST. Six more properties are per-layer lists that ride alongside it —
 * `background-size`, `-position`, `-repeat`, `-attachment`, `-origin`,
 * `-clip` — plus `background-blend-mode`. CSS Backgrounds 3 §2.1 says the
 * layer count is decided by `background-image` alone; a satellite list that is
 * SHORTER is repeated cyclically, and one that is LONGER has its extras
 * ignored.
 *
 * `background-color` is deliberately NOT in that list. It is a single paint
 * below every layer, which is why the Fill section pins it as the bottom-most
 * row rather than treating it as layer N+1.
 *
 * WHAT THIS MODULE REFUSES, AND WHY
 * ---------------------------------
 * Same posture as `boxShadowLayers.ts` and `gradientValue.ts`: a value is only
 * restructured into rows when it can be put back together BYTE-FOR-BYTE.
 * Anything else keeps its raw text, in full, with a named reason. Rewriting a
 * hand-written stylesheet into a form we merely guessed at is the lying-editor
 * bug this codebase exists to refuse (`CLAUDE.md`, invariant 2).
 *
 * The refusals, each with its own reason string:
 *   - a top-level `var()` — it could expand to any number of layers, so the
 *     layer count (and therefore every satellite's alignment) is unknowable;
 *   - unbalanced parentheses or an unterminated string;
 *   - an empty comma segment;
 *   - a value whose re-join is not byte-identical (unusual whitespace);
 *   - a satellite carrying MORE values than there are layers — CSS ignores the
 *     extras, but editing per layer would silently delete them from the user's
 *     source.
 *
 * Crucially the refusal is **per property**, not per section: a stylesheet
 * whose `background-image` is perfectly ordinary but whose `background-size`
 * has one value too many still gets N editable layer rows — only that one
 * satellite falls back to a raw text field inside the popover. A whole-section
 * refusal for one odd satellite would hide six things the user CAN edit.
 *
 * `FillSection.tsx` / `FillSectionParts.tsx` are the only intended callers.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// The satellite properties
// ---------------------------------------------------------------------------

/**
 * Every per-layer `background-*` property, in the order the layer popover
 * draws them. `background-blend-mode` is last because it describes how the
 * layer composites rather than where it sits.
 */
export const BACKGROUND_SATELLITE_PROPS = [
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundAttachment',
  'backgroundOrigin',
  'backgroundClip',
  'backgroundBlendMode',
] as const

export type BackgroundSatelliteProp = (typeof BACKGROUND_SATELLITE_PROPS)[number]

/**
 * Each satellite's CSS initial value. Used when a layer's satellite is written
 * for the first time: CSS has no "leave this one layer alone" syntax, so
 * setting layer 2's size on a 3-layer background must emit three values, and
 * the other two have to be the initial the browser was already using.
 */
export const BACKGROUND_SATELLITE_INITIALS: Readonly<Record<BackgroundSatelliteProp, string>> = {
  backgroundSize: 'auto',
  backgroundPosition: '0% 0%',
  backgroundRepeat: 'repeat',
  backgroundAttachment: 'scroll',
  backgroundOrigin: 'padding-box',
  backgroundClip: 'border-box',
  backgroundBlendMode: 'normal',
}

/** Short, row-sized labels for the layer popover. */
export const BACKGROUND_SATELLITE_LABELS: Readonly<Record<BackgroundSatelliteProp, string>> = {
  backgroundSize: 'Size',
  backgroundPosition: 'Position',
  backgroundRepeat: 'Repeat',
  backgroundAttachment: 'Attachment',
  backgroundOrigin: 'Origin',
  backgroundClip: 'Clip',
  backgroundBlendMode: 'Blend',
}

// ---------------------------------------------------------------------------
// Domain types — schemas are the source of truth (no parallel `interface`).
// ---------------------------------------------------------------------------

const SatelliteStateSchema = Type.Union([
  /** The property is not declared at all. */
  Type.Object({ kind: Type.Literal('unset') }),
  /** The property's comma list, exactly as parsed (may be shorter than the layer count). */
  Type.Object({ kind: Type.Literal('values'), values: Type.Array(Type.String()) }),
  /** The property is real but not splittable per layer — kept verbatim, with why. */
  Type.Object({ kind: Type.Literal('raw'), raw: Type.String(), reason: Type.String() }),
])

export type BackgroundSatelliteState = Static<typeof SatelliteStateSchema>

const BackgroundImageSpineSchema = Type.Union([
  /** No `background-image`, or `none` — there are zero paint layers. */
  Type.Object({ kind: Type.Literal('none') }),
  /** The layer list, index 0 = topmost paint. */
  Type.Object({ kind: Type.Literal('layers'), layers: Type.Array(Type.String()) }),
  /** A real value this module will not restructure — kept verbatim, with why. */
  Type.Object({ kind: Type.Literal('raw'), raw: Type.String(), reason: Type.String() }),
])

export type BackgroundImageSpine = Static<typeof BackgroundImageSpineSchema>

export const BackgroundModelSchema = Type.Object({
  spine: BackgroundImageSpineSchema,
  satellites: Type.Record(Type.String(), SatelliteStateSchema),
})

export type BackgroundModel = Omit<Static<typeof BackgroundModelSchema>, 'satellites'> & {
  satellites: Record<BackgroundSatelliteProp, BackgroundSatelliteState>
}

/** What one layer's satellite resolves to, for the control that edits it. */
export type BackgroundSatelliteView =
  | { kind: 'unset' }
  /** `shared` = this value comes from CSS's cyclic repetition, so it is not this layer's alone. */
  | { kind: 'value'; value: string; shared: boolean }
  | { kind: 'raw'; raw: string; reason: string }

// ---------------------------------------------------------------------------
// Refusal reasons — named once so the UI copy and the tests agree.
// ---------------------------------------------------------------------------

const REASON_VAR =
  'A var() here could expand to any number of layers, so the layer list cannot be trusted. Edit it as text.'
const REASON_UNPARSEABLE =
  'Could not split this into background layers — edit it as text so nothing is lost.'
const REASON_REFORMAT =
  'This value would be reformatted if split into layers, so it stays as text.'
const REASON_EXTRA_VALUES =
  'This has more values than there are background layers. CSS ignores the extras, but editing per layer would delete them, so it stays as text.'

// ---------------------------------------------------------------------------
// Tokenising — depth- AND quote-aware, because `url("a,b.png")` is legal and
// its comma is not a layer boundary.
// ---------------------------------------------------------------------------

/**
 * Splits `value` on top-level commas. Returns `null` when the value has
 * unbalanced parentheses or an unterminated string — both mean we cannot know
 * where the layers actually end.
 */
function splitTopLevelCommas(value: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!
    if (quote !== null) {
      current += char
      if (char === '\\') {
        const escaped = value[i + 1]
        if (escaped !== undefined) {
          current += escaped
          i += 1
        }
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth < 0) return null
    }
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (depth !== 0 || quote !== null) return null
  parts.push(current)
  return parts
}

/**
 * True when `segment` contains a `var(` at nesting depth 0 — the one shape
 * that makes a comma list's length unknowable, because the substitution can
 * itself contain commas. A `var()` NESTED inside a function
 * (`linear-gradient(var(--from), var(--to))`) is fine: it cannot add layers.
 */
function containsTopLevelVar(segment: string): boolean {
  const lower = segment.toLowerCase()
  let depth = 0
  let quote: string | null = null

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!
    if (quote !== null) {
      if (char === '\\') {
        i += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (depth === 0 && lower.startsWith('var(', i)) return true
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
  }
  return false
}

/**
 * Splits a comma list into trimmed segments, or returns a refusal reason.
 * Shared by the `background-image` spine and every satellite: they are the
 * same grammar (a comma list at top level) with different meanings.
 */
function splitCommaList(value: string): { segments: string[] } | { reason: string } {
  const parts = splitTopLevelCommas(value)
  if (parts === null) return { reason: REASON_UNPARSEABLE }

  const segments = parts.map((part) => part.trim())
  if (segments.some((segment) => segment === '')) return { reason: REASON_UNPARSEABLE }
  if (segments.some(containsTopLevelVar)) return { reason: REASON_VAR }
  if (segments.join(', ') !== value.trim()) return { reason: REASON_REFORMAT }

  return { segments }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function readDeclared(styles: Record<string, unknown>, key: string): string | undefined {
  const value = styles[key]
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseSpine(styles: Record<string, unknown>): BackgroundImageSpine {
  const declared = readDeclared(styles, 'backgroundImage')
  if (declared === undefined || declared.toLowerCase() === 'none') return { kind: 'none' }

  const split = splitCommaList(declared)
  if ('reason' in split) return { kind: 'raw', raw: declared, reason: split.reason }
  return { kind: 'layers', layers: split.segments }
}

function parseSatellite(
  styles: Record<string, unknown>,
  prop: BackgroundSatelliteProp,
  layerCount: number | null,
): BackgroundSatelliteState {
  const declared = readDeclared(styles, prop)
  if (declared === undefined) return { kind: 'unset' }

  const split = splitCommaList(declared)
  if ('reason' in split) return { kind: 'raw', raw: declared, reason: split.reason }

  // Extras are ignored by CSS but present in the user's file. Editing per
  // layer re-emits exactly `layerCount` values, which would delete them.
  if (layerCount !== null && split.segments.length > layerCount) {
    return { kind: 'raw', raw: declared, reason: REASON_EXTRA_VALUES }
  }

  return { kind: 'values', values: split.segments }
}

/**
 * Reads the whole `background-*` layer stack out of a stored style bag.
 * Never throws and never loses a value: everything it will not restructure
 * comes back as a `'raw'` state carrying the original text and a reason.
 */
export function parseBackgroundLayers(styles: Record<string, unknown>): BackgroundModel {
  const spine = parseSpine(styles)
  const layerCount = spine.kind === 'layers' && spine.layers.length > 0 ? spine.layers.length : null

  const satellites = {} as Record<BackgroundSatelliteProp, BackgroundSatelliteState>
  for (const prop of BACKGROUND_SATELLITE_PROPS) {
    satellites[prop] = parseSatellite(styles, prop, layerCount)
  }

  return { spine, satellites }
}

/** True when nothing in the background-layer stack is declared at all (Law 1). */
export function isBackgroundModelEmpty(model: BackgroundModel): boolean {
  if (model.spine.kind !== 'none') return false
  return BACKGROUND_SATELLITE_PROPS.every((prop) => model.satellites[prop].kind === 'unset')
}

/** The layers, or `[]` when there is no editable layer list. */
export function backgroundLayerList(model: BackgroundModel): readonly string[] {
  return model.spine.kind === 'layers' ? model.spine.layers : []
}

// ---------------------------------------------------------------------------
// Serialise — back to a style patch the section hands to `onChange`.
// ---------------------------------------------------------------------------

/**
 * Turns a model back into the exact set of properties it owns. `undefined`
 * means "clear this declaration". A model parsed and immediately serialised
 * reproduces its input byte-for-byte — that is the guarantee the `'raw'`
 * states exist to keep true.
 */
export function backgroundModelPatch(
  model: BackgroundModel,
): Partial<Record<keyof CSSPropertyBag, string | undefined>> {
  const patch: Partial<Record<keyof CSSPropertyBag, string | undefined>> = {}

  if (model.spine.kind === 'none') patch.backgroundImage = undefined
  else if (model.spine.kind === 'raw') patch.backgroundImage = model.spine.raw
  else patch.backgroundImage = model.spine.layers.length === 0 ? undefined : model.spine.layers.join(', ')

  for (const prop of BACKGROUND_SATELLITE_PROPS) {
    const state = model.satellites[prop]
    if (state.kind === 'unset') patch[prop] = undefined
    else if (state.kind === 'raw') patch[prop] = state.raw
    else patch[prop] = state.values.length === 0 ? undefined : state.values.join(', ')
  }

  return patch
}

// ---------------------------------------------------------------------------
// Per-layer satellite reads and writes
// ---------------------------------------------------------------------------

/** What layer `index` currently resolves to for `prop`. */
export function backgroundLayerSatellite(
  model: BackgroundModel,
  prop: BackgroundSatelliteProp,
  index: number,
): BackgroundSatelliteView {
  const state = model.satellites[prop]
  if (state.kind === 'unset') return { kind: 'unset' }
  if (state.kind === 'raw') return { kind: 'raw', raw: state.raw, reason: state.reason }
  if (state.values.length === 0) return { kind: 'unset' }

  const layerCount = backgroundLayerList(model).length
  return {
    kind: 'value',
    value: state.values[index % state.values.length]!,
    shared: state.values.length < layerCount,
  }
}

/** Expands a satellite list to one value per layer, filling with the CSS initial. */
function expandSatellite(
  state: BackgroundSatelliteState,
  prop: BackgroundSatelliteProp,
  layerCount: number,
): string[] {
  const initial = BACKGROUND_SATELLITE_INITIALS[prop]
  const source = state.kind === 'values' && state.values.length > 0 ? state.values : null
  return Array.from({ length: layerCount }, (_, i) => (source ? source[i % source.length]! : initial))
}

/** Collapses a full-length list back to its shortest byte-identical CSS form. */
function collapseSatellite(values: string[], prop: BackgroundSatelliteProp): BackgroundSatelliteState {
  const initial = BACKGROUND_SATELLITE_INITIALS[prop]
  if (values.length === 0 || values.every((value) => value === initial)) return { kind: 'unset' }
  if (values.every((value) => value === values[0])) return { kind: 'values', values: [values[0]!] }
  return { kind: 'values', values }
}

/**
 * Writes one layer's satellite. `undefined` resets that layer to the CSS
 * initial — which, once every layer is back at the initial, clears the whole
 * declaration rather than leaving `auto, auto, auto` behind.
 *
 * A `'raw'` satellite is returned unchanged: the caller must offer that
 * property's raw text field instead of a per-layer control, because a
 * per-layer write is exactly what we refused to do.
 */
export function setBackgroundLayerSatellite(
  model: BackgroundModel,
  prop: BackgroundSatelliteProp,
  index: number,
  value: string | undefined,
): BackgroundModel {
  const state = model.satellites[prop]
  if (state.kind === 'raw') return model

  const layerCount = backgroundLayerList(model).length
  if (layerCount === 0 || index < 0 || index >= layerCount) return model

  const next = expandSatellite(state, prop, layerCount)
  next[index] = value === undefined || value === '' ? BACKGROUND_SATELLITE_INITIALS[prop] : value

  return { ...model, satellites: { ...model.satellites, [prop]: collapseSatellite(next, prop) } }
}

// ---------------------------------------------------------------------------
// Structural edits — add / remove / reorder a layer, satellites in step
// ---------------------------------------------------------------------------

/**
 * Applies a structural change to every satellite alongside the layer list.
 *
 * A ONE-value list is left alone: it already applies to every layer by CSS's
 * repetition rule, and that stays true whatever the layer count becomes —
 * rewriting it would churn the user's source for nothing. Anything longer is
 * expanded to the pre-edit layer count first, so the reindex is unambiguous.
 */
function restructureSatellites(
  model: BackgroundModel,
  previousLayerCount: number,
  reindex: (values: string[], prop: BackgroundSatelliteProp) => string[],
): Record<BackgroundSatelliteProp, BackgroundSatelliteState> {
  // With no layers to align to, a satellite's list means nothing this module
  // can reindex — touching it would delete values it cannot place. Leave it
  // exactly as the user wrote it; the next parse decides what to do with it.
  if (previousLayerCount === 0) return model.satellites

  const satellites = {} as Record<BackgroundSatelliteProp, BackgroundSatelliteState>

  for (const prop of BACKGROUND_SATELLITE_PROPS) {
    const state = model.satellites[prop]
    if (state.kind !== 'values' || state.values.length <= 1) {
      satellites[prop] = state
      continue
    }
    const expanded = expandSatellite(state, prop, previousLayerCount)
    satellites[prop] = collapseSatellite(reindex(expanded, prop), prop)
  }

  return satellites
}

/**
 * Inserts a layer's CSS text at `index` (0 = topmost, matching CSS paint
 * order and Figma's list). Only meaningful when the spine parsed into layers —
 * a raw spine is returned unchanged, because we do not know where its layers
 * begin.
 */
export function insertBackgroundLayer(model: BackgroundModel, index: number, image: string): BackgroundModel {
  const layers = backgroundLayerList(model).slice()
  if (model.spine.kind === 'raw') return model

  const previousLayerCount = layers.length
  const at = Math.max(0, Math.min(index, previousLayerCount))
  layers.splice(at, 0, image)

  // The new layer starts at every satellite's CSS initial — the browser's own
  // behaviour for a layer nobody has configured.
  const satellites = restructureSatellites(model, previousLayerCount, (values, prop) => {
    const next = values.slice()
    next.splice(at, 0, BACKGROUND_SATELLITE_INITIALS[prop])
    return next
  })

  return { spine: { kind: 'layers', layers }, satellites }
}

/**
 * Removes layer `index`. When the last layer goes, every satellite is cleared
 * too: a `background-size` with no `background-image` left to size is dead
 * text in the user's stylesheet, and leaving it behind is what made the old
 * image row refuse to disappear after "remove".
 */
export function removeBackgroundLayer(model: BackgroundModel, index: number): BackgroundModel {
  const previous = backgroundLayerList(model)
  if (model.spine.kind !== 'layers' || index < 0 || index >= previous.length) return model

  const layers = previous.filter((_, i) => i !== index)
  if (layers.length === 0) {
    const cleared = {} as Record<BackgroundSatelliteProp, BackgroundSatelliteState>
    for (const prop of BACKGROUND_SATELLITE_PROPS) cleared[prop] = { kind: 'unset' }
    return { spine: { kind: 'none' }, satellites: cleared }
  }

  const satellites = restructureSatellites(model, previous.length, (values) =>
    values.filter((_, i) => i !== index),
  )
  return { spine: { kind: 'layers', layers }, satellites }
}

/** Moves layer `from` to `to`, carrying every per-layer satellite with it. */
export function moveBackgroundLayer(model: BackgroundModel, from: number, to: number): BackgroundModel {
  const previous = backgroundLayerList(model)
  if (model.spine.kind !== 'layers') return model
  if (from < 0 || to < 0 || from >= previous.length || to >= previous.length || from === to) return model

  const move = <T,>(list: T[]): T[] => {
    const next = list.slice()
    const [moved] = next.splice(from, 1)
    if (moved !== undefined) next.splice(to, 0, moved)
    return next
  }

  return {
    spine: { kind: 'layers', layers: move(previous.slice()) },
    satellites: restructureSatellites(model, previous.length, move),
  }
}

/** Replaces layer `index`'s image text (a gradient, a `url()`, or raw CSS). */
export function setBackgroundLayerImage(model: BackgroundModel, index: number, image: string): BackgroundModel {
  const previous = backgroundLayerList(model)
  if (model.spine.kind !== 'layers' || index < 0 || index >= previous.length) return model
  const layers = previous.map((layer, i) => (i === index ? image : layer))
  return { ...model, spine: { kind: 'layers', layers } }
}
