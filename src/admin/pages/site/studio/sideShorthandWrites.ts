/**
 * sideShorthandWrites - the wire form of a per-side `padding` / `margin` edit.
 *
 * The property bag stores spacing per side ONLY (`paddingTop` ... `paddingLeft`,
 * see `cssPropertyBag.ts`), and the inspector's "all sides" field changes all
 * four in one patch. Writing those four to the user's source one by one turned
 * `padding: 16px` into four lines the first time anything touched it, and a
 * human writes four equal sides as one declaration.
 *
 * So the BAG stays per-side and only what goes over the wire changes:
 *
 *   - all four sides of a box set in one save -> ONE shorthand
 *     (`padding: 16px`, `padding: 8px 16px`, ...) and the four longhands
 *     removed, so a longhand that already sat in the source cannot out-rank
 *     the shorthand by position;
 *   - all four sides removed in one save (an undo of the above, a cleared
 *     field) -> the four longhands AND the shorthand removed, because the
 *     shorthand is what an earlier save of this same rule wrote.
 *
 * Fewer than four sides is left alone: one longhand next to a hand-written
 * shorthand is how CSS wants an override written, and collapsing a partial
 * patch would reset the sides it did not mention.
 *
 * Pure, and applied ONLY to the outgoing edit: the loaded-values baseline keeps
 * the per-side keys the bag actually holds, so the next save's diff stays empty.
 */
import { buildSidesShorthand } from '@core/publisher'

const BOXES = ['padding', 'margin'] as const
const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const

type Box = (typeof BOXES)[number]

function longhands(box: Box): string[] {
  return SIDES.map((side) => `${box}${side}`)
}

/** An inline-style diff in the wire shape `setJsxStyle` takes. */
export interface InlineStyleWrite {
  style: Record<string, string | number>
  remove: string[]
}

export function coalesceInlineSideWrites(
  changed: Readonly<Record<string, string | number>>,
  removed: readonly string[],
): InlineStyleWrite {
  const style: Record<string, string | number> = { ...changed }
  const remove: string[] = [...removed]
  for (const box of BOXES) {
    const props = longhands(box)
    const values = props.map((prop) => changed[prop])
    if (values.every((value): value is string => typeof value === 'string')) {
      for (const prop of props) delete style[prop]
      remove.push(...props)
      style[box] = buildSidesShorthand(values[0], values[1], values[2], values[3])
    } else if (props.every((prop) => removed.includes(prop))) {
      remove.push(box)
    }
  }
  return { style, remove }
}

/** One kebab-cased declaration change: a value to write, or `null` to remove it. */
export type DeclarationChange = { property: string; value: string } | { property: string; value: null }

export function coalesceCssSideChanges(changes: readonly DeclarationChange[]): DeclarationChange[] {
  let result: DeclarationChange[] = [...changes]
  for (const box of BOXES) {
    const props = SIDES.map((side) => `${box}-${side.toLowerCase()}`)
    const sides = props.map((prop) => result.find((change) => change.property === prop))
    if (sides.every((change) => change !== undefined && typeof change.value === 'string')) {
      const [top, right, bottom, left] = sides.map((change) => change!.value as string)
      result = [
        ...result.filter((change) => !props.includes(change.property)),
        ...props.map((property): DeclarationChange => ({ property, value: null })),
        { property: box, value: buildSidesShorthand(top, right, bottom, left) },
      ]
    } else if (sides.every((change) => change !== undefined && change.value === null)) {
      result = [...result, { property: box, value: null }]
    }
  }
  return result
}
