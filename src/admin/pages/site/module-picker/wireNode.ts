/**
 * wireNode — the primitive vocabulary every module thumbnail is drawn in.
 *
 * A leaf module on purpose. `moduleWireframes.ts` (the hand-drawn `base.*`
 * table) and `moduleArchetype.ts` (the shape derived from a module's own
 * schema) both compose these, and both are consumed by the other: the table
 * falls back to the derivation, and the derivation is written in the table's
 * vocabulary. Left in one file that was an import CYCLE, and not a harmless
 * one — `moduleArchetype`'s top-level `LEAF_GLYPH` calls `row()` during module
 * evaluation, so the cycle threw `ReferenceError: Cannot access 'row' before
 * initialization` and took the entire module picker down. `tsc` compiled it
 * happily; only running it showed the fault.
 */
type WireNodeKind =
  | 'box'
  | 'button'
  | 'check'
  | 'col'
  | 'dot'
  | 'field'
  | 'gap'
  | 'icon'
  | 'image'
  | 'lines'
  | 'pill'
  | 'radio'
  | 'row'
  | 'rule'

export interface WireNode {
  kind: WireNodeKind
  children?: WireNode[]
  count?: number
  width?: number
  height?: number
  flex?: number
  gap?: number
  pad?: number
  align?: 'start' | 'center' | 'end'
  avatar?: boolean
  bar?: boolean
  big?: boolean
  card?: boolean
  caret?: boolean
  center?: boolean
  code?: boolean
  dashed?: boolean
  link?: boolean
  logo?: boolean
  message?: boolean
  mono?: boolean
  play?: boolean
  solid?: boolean
  tip?: boolean
  vertical?: boolean
}

export const row = (children: WireNode[], node: Partial<WireNode> = {}): WireNode => ({
  kind: 'row',
  children,
  ...node,
})

export const col = (children: WireNode[], node: Partial<WireNode> = {}): WireNode => ({
  kind: 'col',
  children,
  ...node,
})

export const box = (children: WireNode[] = [], node: Partial<WireNode> = {}): WireNode => ({
  kind: 'box',
  children,
  ...node,
})

export const lines = (count = 3, node: Partial<WireNode> = {}): WireNode => ({
  kind: 'lines',
  count,
  ...node,
})

export const field = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'field', ...node })
export const image = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'image', ...node })
export const button = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'button', ...node })
export const icon = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'icon', ...node })
export const dot = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'dot', ...node })
export const check = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'check', ...node })
export const radio = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'radio', ...node })
export const rule = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'rule', ...node })
