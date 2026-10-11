/**
 * instanceChildrenSlot - OD-22: a drop into a component instance that needs no
 * detach.
 *
 * A layout-style component (`<Shell><Header/>{children}<Footer/></Shell>`)
 * takes ELEMENTS as props. Dropping an element "into" one of its instances has
 * one honest target in the user's source that is not the component: between the
 * `<Shell>` tags at the call site, which is exactly where the component renders
 * it. Nothing in the component changes, so no other instance can, and nothing
 * is detached.
 *
 * The parser names that place. `ParsedNode.instanceOf.childrenHost` is the id of
 * the ONE plain element that renders the component's `{children}`; it rides to
 * the board as `props.childrenHost` on the instance node. This module is the
 * pure reading of it, shared by the drop preview, the store's plans and the
 * transplant - three surfaces that must not disagree about where a drop lands.
 *
 * What it deliberately does not do: guess. An instance whose component renders
 * no children (or renders them in two places, or in a branch) has no
 * `childrenHost`, so a drop into it is a gesture inside the component's own
 * markup, which is a detach (`instanceOnlyGesture.ts`) - never a write into a
 * call site that would render nothing.
 */
import { INLINE_ID_SEPARATOR } from './sourceNodeId'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

const INSTANCE_MODULE_ID = 'studio.instance'

/** A local component call site the parser inlined (`studio.instance`). */
export function isInstanceNode(node: PageNode | undefined): node is PageNode {
  return node?.moduleId === INSTANCE_MODULE_ID
}

/** The element that renders the instance's `{children}`, when the parser found exactly one. */
function childrenHostOf(instance: PageNode): string | undefined {
  const host = (instance.props as { childrenHost?: unknown } | undefined)?.childrenHost
  return typeof host === 'string' ? host : undefined
}

/** An instance and the inlined element that renders its call-site children. */
export interface InstanceChildrenSlot {
  instance: PageNode
  host: PageNode
}

/**
 * The slot a drop into `containerId` fills, or `null` when `containerId` is
 * not one: either the instance itself (a drop onto the component as a whole
 * lands in its children) or the element that renders them.
 */
export function instanceChildrenSlot(tree: NodeTree<PageNode>, containerId: string): InstanceChildrenSlot | null {
  const container = tree.nodes[containerId]
  if (!container) return null
  const instance = isInstanceNode(container) ? container : instanceOwningHost(tree, container)
  if (!instance) return null
  const hostId = childrenHostOf(instance)
  const host = hostId === undefined ? undefined : tree.nodes[hostId]
  return host ? { instance, host } : null
}

/** The instance whose children slot `host` is: the call site one `~` segment up its id. */
function instanceOwningHost(tree: NodeTree<PageNode>, host: PageNode): PageNode | undefined {
  const cut = host.id.lastIndexOf(INLINE_ID_SEPARATOR)
  if (cut < 0) return undefined
  const instance = tree.nodes[host.id.slice(0, cut)]
  return isInstanceNode(instance) && childrenHostOf(instance) === host.id ? instance : undefined
}

/**
 * The instance `containerId` IS, when it is one whose component renders no
 * children: a drop onto it has no call-site place to go. `null` for anything
 * else (including an instance that does have a slot).
 */
export function instanceWithoutChildrenSlot(tree: NodeTree<PageNode>, containerId: string): PageNode | null {
  const container = tree.nodes[containerId]
  if (!isInstanceNode(container)) return null
  return childrenHostOf(container) === undefined ? container : null
}

/** True for a child of the slot's host that the CALL SITE wrote (not one of the component's own elements). */
export function isCallSiteChild(slot: InstanceChildrenSlot, childId: string): boolean {
  return !childId.startsWith(`${slot.instance.id}${INLINE_ID_SEPARATOR}`)
}
