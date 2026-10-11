/**
 * layerStyleModel - what a loose layer's inspector reads from the layer's root
 * element and the inline-style edit each control becomes.
 *
 * A loose layer is one element in its own module (`.studio/canvas/<id>.tsx`),
 * styled the way the draw tools write it: inline `style={{ ... }}` values. So
 * its controls read and write exactly those, one honest target. A value the
 * module computes in code (a variable, a call) is not a literal the inspector
 * can restate, and the control that would overwrite it says so instead.
 *
 * Pure: no store, no network.
 */
import type { PageNode } from '@core/page-tree'

export type LayerStyleKey = 'width' | 'height' | 'background' | 'backgroundColor' | 'borderRadius' | 'opacity' | 'border' | 'color' | 'fontSize'

/** One inline-style change: values to set (CSS text) and properties to take off. */
export interface LayerStyleChange {
  set: Record<string, string>
  remove: string[]
}

export interface Stroke {
  width: string
  color: string
}

export interface LayerStyleReading {
  width: string | null
  height: string | null
  fill: string | null
  /** Which property holds the fill, so a write goes where the value already is. */
  fillKey: 'background' | 'backgroundColor'
  radius: string | null
  /** 0-100, or null when unset (opaque). */
  opacityPercent: string | null
  /** The `border` shorthand split in two, `null` when there is none, `'custom'` when it is not `<width> solid <colour>`. */
  stroke: Stroke | null | 'custom'
  textColor: string | null
  fontSize: string | null
}

const BORDER = /^\s*(\d*\.?\d+)(?:px)?\s+solid\s+(\S.*?)\s*$/i

/** An inline value as the text a control shows: a bare number is React's pixels. */
function textOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? '0' : `${value}px`
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

/** `12px` and `12` both read as 12; anything else (`50%`, `calc(...)`) stays as written. */
export function lengthText(value: string | null): string | null {
  if (value === null) return null
  const match = /^(-?\d*\.?\d+)(?:px)?$/.exec(value)
  return match ? match[1]! : value
}

/** What a typed length means: a bare number is pixels, a number with a unit is kept. */
export function lengthValue(typed: string): string | null {
  const text = typed.trim()
  if (text === '') return null
  return /^-?\d*\.?\d+$/.test(text) ? `${text}px` : text
}

export function readLayerStyle(node: PageNode): LayerStyleReading {
  const inline = node.inlineStyles ?? {}
  const fillKey = inline.background === undefined && inline.backgroundColor !== undefined ? 'backgroundColor' : 'background'
  const border = textOf(inline.border)
  const borderMatch = border === null ? null : BORDER.exec(border)
  const opacity = textOf(inline.opacity)
  return {
    width: textOf(inline.width),
    height: textOf(inline.height),
    fill: textOf(inline[fillKey]),
    fillKey,
    radius: textOf(inline.borderRadius),
    opacityPercent: opacity !== null && Number.isFinite(Number(opacity)) ? String(Math.round(Number(opacity) * 1000) / 10) : null,
    stroke: border === null ? null : borderMatch ? { width: borderMatch[1]!, color: borderMatch[2]! } : 'custom',
    textColor: textOf(inline.color),
    fontSize: textOf(inline.fontSize),
  }
}

/** The change that sets (or, for `null`, removes) one inline property. */
export function styleChange(property: LayerStyleKey, value: string | null): LayerStyleChange {
  return value === null ? { set: {}, remove: [property] } : { set: { [property]: value }, remove: [] }
}

/** The `border` shorthand for a stroke, or its removal when there is no colour. */
export function strokeChange(stroke: Stroke | null): LayerStyleChange {
  if (stroke === null || stroke.color.trim() === '') return styleChange('border', null)
  const width = stroke.width.trim() === '' ? '1' : stroke.width.trim()
  return styleChange('border', `${width}px solid ${stroke.color.trim()}`)
}

/** Opacity typed as a percentage: 100 is the default and takes the property off. */
export function opacityChange(percentText: string): LayerStyleChange | null {
  const percent = Number.parseFloat(percentText)
  if (!Number.isFinite(percent)) return null
  const clamped = Math.min(100, Math.max(0, percent))
  return styleChange('opacity', clamped >= 100 ? null : String(Math.round(clamped * 10) / 1000))
}

/**
 * What `change` overwrites: the node's current value of every property it
 * touches (`undefined` = absent), which is the inverse's content.
 */
export function previousValues(node: PageNode, change: LayerStyleChange): Record<string, string | number | undefined> {
  const inline = node.inlineStyles ?? {}
  const previous: Record<string, string | number | undefined> = {}
  for (const property of [...Object.keys(change.set), ...change.remove]) {
    const value = inline[property]
    previous[property] = typeof value === 'string' || typeof value === 'number' ? value : undefined
  }
  return previous
}
