/**
 * variantGrid — which combinations of a component's variant axes the
 * variants gallery shows. Pure: axes in, a plan out. Nothing here reads a
 * file or renders anything, so the cap rule is testable on its own and the
 * server module that turns a plan into call sites stays about call sites.
 *
 * An axis is an enum prop (one value per union member) or a boolean prop
 * (`false`, `true`). The gallery renders the cartesian product, but a
 * component with four 3-way axes would be 81 cells, so the product is capped:
 * axes are taken in the order the component declares them while the running
 * product still fits, and every axis that would push it past the cap is PINNED
 * to one value (its declared default when it is a member, else the first
 * member / `false`). The plan says what was pinned and how many combinations
 * exist in total, so the frame can say "24 of 81" instead of pretending.
 */
import type { PropDefault } from './variantSchema'

/** Most cells one component's gallery frame renders. */
export const MAX_GALLERY_CELLS = 24

/** One enum/boolean prop as the gallery sees it. */
export interface GalleryAxisInput {
  name: string
  kind: 'enum' | 'boolean'
  /** Enum members, in declaration order. Ignored for a boolean. */
  members: readonly string[]
  /** The destructuring default (`variant = 'primary'`), when the author wrote a literal one. */
  defaultValue?: PropDefault
}

export type GalleryValue = string | boolean

export interface GalleryAxis {
  name: string
  values: readonly GalleryValue[]
}

export interface GalleryCell {
  /** Position in the plan, row-major with the LAST shown axis varying fastest. */
  index: number
  /** Value of every shown axis plus every pinned one — exactly what the call site is given. */
  values: Readonly<Record<string, GalleryValue>>
  /** `variant=primary, size=sm` — shown axes only; pinned values are stated once in the plan. */
  label: string
}

export interface GalleryPlan {
  /** The axes that vary across cells, in declaration order. */
  axes: readonly GalleryAxis[]
  /** Axes held at one value because showing them would exceed the cap. */
  pinned: readonly { name: string; value: GalleryValue }[]
  cells: readonly GalleryCell[]
  /** Size of the full product over every varying axis, shown or not. */
  total: number
}

function valuesOf(axis: GalleryAxisInput): readonly GalleryValue[] {
  return axis.kind === 'boolean' ? [false, true] : axis.members
}

function pinnedValueOf(axis: GalleryAxisInput): GalleryValue {
  const values = valuesOf(axis)
  const declared = axis.defaultValue
  const match = values.find((value) => value === declared)
  if (match !== undefined) return match
  return values[0] as GalleryValue
}

/**
 * The combinations to render for `inputs`, or `null` when there is nothing to
 * vary (no axis with two or more values — a lone variant is not a gallery).
 */
export function planVariantGrid(inputs: readonly GalleryAxisInput[], cap: number = MAX_GALLERY_CELLS): GalleryPlan | null {
  const varying = inputs.filter((axis) => valuesOf(axis).length >= 2)
  if (varying.length === 0) return null

  let total = 1
  for (const axis of varying) total *= valuesOf(axis).length

  const shown: GalleryAxis[] = []
  const pinned: { name: string; value: GalleryValue }[] = []
  let product = 1
  for (const axis of varying) {
    // An axis larger than the cap on its own (a 40-member enum) is shown by
    // its first `cap` members; `total` above still reports the full product.
    const values = valuesOf(axis).slice(0, cap)
    if (product * values.length <= cap) {
      shown.push({ name: axis.name, values })
      product *= values.length
    } else {
      pinned.push({ name: axis.name, value: pinnedValueOf(axis) })
    }
  }

  const pinnedValues = Object.fromEntries(pinned.map(({ name, value }) => [name, value]))
  const cells: GalleryCell[] = []
  const count = shown.reduce((n, axis) => n * axis.values.length, 1)
  for (let index = 0; index < count; index++) {
    const values: Record<string, GalleryValue> = { ...pinnedValues }
    let rest = index
    for (let a = shown.length - 1; a >= 0; a--) {
      const axis = shown[a]!
      values[axis.name] = axis.values[rest % axis.values.length]!
      rest = Math.floor(rest / axis.values.length)
    }
    const label = shown.map((axis) => `${axis.name}=${String(values[axis.name])}`).join(', ')
    cells.push({ index, values, label })
  }
  return { axes: shown, pinned, cells, total }
}
