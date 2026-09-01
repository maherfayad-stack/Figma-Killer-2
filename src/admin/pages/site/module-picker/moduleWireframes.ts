import type { NodeTree, PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { archetypeWire } from './moduleArchetype'
import { box, button, check, col, dot, field, icon, image, lines, radio, row, type WireNode } from './wireNode'

export type { WireNode } from './wireNode'

export const MODULE_WIRES: Readonly<Record<string, WireNode>> = {
  'base.body': box([], { dashed: true, height: 52 }),
  'base.button': row([button({ width: 48 })], { center: true, align: 'center', height: 40 }),
  'base.checkbox': row([check(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
  'base.container': box([], { dashed: true, height: 52 }),
  'base.outlet': col([lines(1, { big: true, width: 60 }), lines(3), image({ height: 30 }), lines(2)], { gap: 6 }),
  'base.form': col([field(), field(), button({ width: 40 })], { gap: 6 }),
  'base.form-message': box([row([icon(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })], { pad: 6, message: true }),
  'base.image': image({ height: 52 }),
  'base.input': col([lines(1, { width: 28 }), field()], { gap: 4 }),
  'base.label': lines(1, { width: 34 }),
  'base.link': lines(1, { width: 44, link: true }),
  'base.list': col([
    row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
    row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
    row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
  ], { gap: 6 }),
  'base.loop': col([
    row([image({ width: 18, height: 18 }), lines(2, { flex: 1 })], { gap: 6, align: 'center' }),
    row([image({ width: 18, height: 18 }), lines(2, { flex: 1 })], { gap: 6, align: 'center' }),
  ], { gap: 6 }),
  'base.option': col([lines(1, { width: 28 }), field({ caret: true })], { gap: 4 }),
  'base.option-group': col([lines(1, { width: 42 }), field({ caret: true })], { gap: 4 }),
  'base.radio': col([
    row([radio(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
    row([radio(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
  ], { gap: 6 }),
  'base.select': col([lines(1, { width: 28 }), field({ caret: true })], { gap: 4 }),
  'base.slot-instance': box([], { dashed: true, height: 42 }),
  'base.slot-outlet': box([lines(1, { width: 52, center: true })], { dashed: true, height: 44, center: true }),
  'base.submit': row([button({ width: 52, solid: true })], { center: true, height: 40 }),
  'base.svg': box([icon({ big: true })], { dashed: true, height: 52, center: true }),
  'base.text': lines(3),
  'base.textarea': col([lines(1, { width: 28 }), field({ height: 28 })], { gap: 4 }),
  'base.video': image({ height: 52, play: true }),
  'base.visual-component-ref': box([icon({ big: true }), lines(1, { width: 54, center: true })], {
    dashed: true,
    height: 52,
    center: true,
    gap: 6,
  }),
}


/**
 * The wireframe for a module id.
 *
 * Hand-drawn entry first, then a shape DERIVED from the module's own
 * declaration (`./moduleArchetype`), then the category guess.
 *
 * The derivation step is what makes this work for a real project. `MODULE_WIRES`
 * only ever covered the 25 `base.*` ids, and a design-system project's picker is
 * ~44 package components out of 46 — every one of which used to fall through to
 * `base.container`'s empty dashed box, so Badge, Banner, Button and
 * BottomActionBar were pixel-identical thumbnails. The module registry already
 * holds each one's real `schema`, so the shape is derivable instead of authored,
 * for any package rather than one hardcoded design system.
 *
 * The registry lookup is why this stayed a single-argument function instead of
 * taking the definition: `wireFromTree` below resolves ids out of a node tree
 * and has no definition in hand, so both callers get the improvement from one
 * change.
 */
export function moduleWireForId(moduleId: string, category?: string): WireNode {
  const known = MODULE_WIRES[moduleId]
  if (known) return known

  const definition = registry.get(moduleId)
  if (definition) return archetypeWire({ name: definition.name, schema: definition.schema })

  if (category === 'Forms') return MODULE_WIRES['base.form']
  if (category === 'Media') return MODULE_WIRES['base.image']
  if (category === 'Interactive') return MODULE_WIRES['base.button']
  if (category === 'Typography') return MODULE_WIRES['base.text']
  if (category === 'CMS') return MODULE_WIRES['base.outlet']
  return MODULE_WIRES['base.container']
}

export function wireFromTree(tree: NodeTree<PageNode>): WireNode {
  const root = tree.nodes[tree.rootNodeId]
  if (!root) return moduleWireForId('base.container')

  const children = root.children
    .map((childId) => tree.nodes[childId])
    .filter((node): node is PageNode => Boolean(node))
    .slice(0, 4)

  if (children.length === 0) return moduleWireForId(root.moduleId)

  return col(
    children.map((node) => {
      if (node.children.length > 0) return wireFromNode(tree, node.id)
      return moduleWireForId(node.moduleId)
    }),
    { gap: 6, pad: 4 },
  )
}

function wireFromNode(tree: NodeTree<PageNode>, nodeId: string): WireNode {
  const node = tree.nodes[nodeId]
  if (!node) return moduleWireForId('base.container')
  const children = node.children
    .map((childId) => tree.nodes[childId])
    .filter((child): child is PageNode => Boolean(child))
    .slice(0, 3)

  if (children.length === 0) return moduleWireForId(node.moduleId)

  return box(
    children.map((child) => moduleWireForId(child.moduleId)),
    { dashed: true, gap: 5, pad: 5 },
  )
}

