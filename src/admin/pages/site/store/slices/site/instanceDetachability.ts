/**
 * instanceDetachability — which selected nodes the ONE Detach action
 * (`instanceActions.ts`) is about, and which of them it must refuse before
 * anything is posted, with the sentence that says why.
 *
 * A component CALL SITE reaches the board in one of three shapes:
 *
 *   - `studio.instance` — a local component the parser inlined (WS-4.2). The
 *     detach codemod decides the rest on the server.
 *   - `alm.<Name>` — a component the parser left OPAQUE. When the registry has
 *     a module for it declaring `sourceImport.kind === 'design-system'`, it is
 *     Studio's own design system, reached through the project's managed
 *     `design-system/` folder: not the user's source, so there is nothing of
 *     theirs to inline (`docs/features/studio-import.md` §"Why
 *     `<project>/design-system/` is a black box"). When the registry has NO
 *     such module, it is a local call site inlining declined to expand
 *     (`moduleMapping.ts`'s fallback) — still one call site in the user's own
 *     file, so it goes to the server like an instance, and the codemod either
 *     detaches it or refuses with its own reason.
 *   - `pkg.<package>.<Name>` — an npm package component. Refused: detaching a
 *     package component is not available yet.
 *
 * Before this module the action simply ignored every `alm.*` and `pkg.*` node,
 * so ⌘⌥B on a design-system button did nothing at all and neither menu offered
 * the item — "I can't detach components for some reason", with no reason
 * anywhere (invariant 2: a refusal says why).
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
  const sourceImport = registry.get(node.moduleId)?.sourceImport
  if (sourceImport?.kind === 'package') return packageRefusal(label)
  if (sourceImport?.kind === 'design-system') {
    return (
      `${label} is a design-system component. Its code lives in the design-system/ folder Studio manages ` +
      'for this project, not in your own source, so there is nothing of yours to detach it into. ' +
      'Change it through its props instead.'
    )
  }
  return null
}

function packageRefusal(label: string): string {
  return `${label} comes from a package, not from your own source. Detaching a package component is not available yet.`
}
