/**
 * instanceDetachability - which selected nodes the ONE Detach action
 * (`instanceActions.ts`) is about, and which of them it must refuse before
 * anything is posted, with the sentence that says why.
 *
 * A component CALL SITE reaches the board in one of three shapes:
 *
 *   - `studio.instance` - a local component the parser inlined (WS-4.2). The
 *     detach codemod decides the rest on the server.
 *   - `alm.<Name>` - a component the parser left OPAQUE. Two kinds:
 *     Studio's own design system, reached through the project's `design-system/`
 *     folder (a registered module declaring `sourceImport.kind ===
 *     'design-system'`), and a local call site inlining declined to expand
 *     (`moduleMapping.ts`'s fallback). OD-21: the folder is real, in-project
 *     code - `<project>/design-system/components/Chip.jsx` is a file in the
 *     user's repository - so both are one call site in the user's own file and
 *     go to the server like an instance. The codemod inlines what it can read
 *     and refuses the rest by name (`detachComponent.ts`), leaving the folder
 *     byte-identical either way.
 *   - `pkg.<package>.<Name>` - an npm package component. Refused: there is no
 *     source of the user's to inline, and the registry knows nothing about it
 *     beyond a name.
 *
 * Before this module the action simply ignored every `alm.*` and `pkg.*` node,
 * so Cmd+Alt+B on a design-system button did nothing at all and neither menu
 * offered the item - "I can't detach components for some reason", with no
 * reason anywhere (invariant 2: a refusal says why).
 */
import { registry } from '@core/module-engine'
import type { PageNode } from '@core/page-tree'

const INSTANCE_MODULE_ID = 'studio.instance'
const DESIGN_SYSTEM_MODULE_PREFIX = 'alm.'
const PACKAGE_MODULE_PREFIX = 'pkg.'

/** A component call site Detach is about — whether or not it will go on to refuse. */
export function isDetachCandidate(node: PageNode | undefined): node is PageNode {
  if (!node) return false
  return (
    node.moduleId === INSTANCE_MODULE_ID ||
    node.moduleId.startsWith(DESIGN_SYSTEM_MODULE_PREFIX) ||
    node.moduleId.startsWith(PACKAGE_MODULE_PREFIX)
  )
}

/** The component's own name, for a sentence. */
export function detachComponentLabel(node: PageNode): string {
  const name = (node.props as { componentName?: unknown }).componentName
  if (typeof name === 'string' && name) return name
  const imported = registry.get(node.moduleId)?.sourceImport?.name
  if (imported) return imported
  return node.moduleId.slice(node.moduleId.lastIndexOf('.') + 1) || 'instance'
}

/**
 * Why `node` cannot be detached, decided without asking the server — or
 * `null` when the server is the one to decide (a local call site).
 */
export function detachRefusalFor(node: PageNode): string | null {
  const label = detachComponentLabel(node)
  if (node.moduleId === INSTANCE_MODULE_ID) {
    return (node.props as { source?: unknown }).source === 'package' ? packageRefusal(label) : null
  }
  if (node.moduleId.startsWith(PACKAGE_MODULE_PREFIX)) return packageRefusal(label)
  if (registry.get(node.moduleId)?.sourceImport?.kind === 'package') return packageRefusal(label)
  return null
}

function packageRefusal(label: string): string {
  return `${label} comes from a package, not from your own source. There is no source of yours to detach it into.`
}
