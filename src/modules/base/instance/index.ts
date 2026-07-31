/**
 * `studio.instance` — WS-4.2's fragment node. A component CALL SITE
 * `inlineLocalComponents` successfully expanded, kept in the tree instead of
 * being replaced by its own inlined subtree (the pre-WS-4 design — see
 * `src/core/page-parser/inlineLocalComponents.ts`'s module header). Renders
 * as a React Fragment (`InstanceEditor`) — zero DOM elements — so every
 * reason the old "replace, don't wrap" design existed is preserved exactly,
 * while the call site itself becomes an addressable, editable node: its
 * call-site props are editable (§4.3), and it is what `detachComponent`/
 * `swapComponentInstance` (§4.4/4.5, `src/core/ast-codemods/`) act on.
 *
 * Studio-only, no publisher representation (`meta-03` decision 4 — Studio
 * boards are not published, the filesystem is the source of truth) — same
 * `publishBehavior: 'transparent'` posture as `base.slot-instance`.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { Value } from '@core/utils/typeboxHelpers'
import { InstanceEditor } from './InstanceEditor'
import { InstancePropsSchema, type InstanceStoredProps } from './props'

export const InstanceModule: ModuleDefinition<InstanceStoredProps> = {
  id: 'studio.instance',
  name: 'Instance',
  description: 'An instance of a local component',
  category: 'Components',
  version: '1.0.0',
  icon: BoxStackSolidIcon,
  trusted: true,
  canHaveChildren: true,

  // Renders no element of its own — see `InstanceEditor`'s doc comment.
  // Nothing to publish (studio-only, see this file's own header).
  publishBehavior: 'transparent',

  // No declarative schema: the editable surface is the call-site prop bag
  // (`props.callSiteProps`), which is classified per-instance from the
  // target component's own TS signature (WS-3.1's `PropKind`), not a fixed
  // property-control map every instance would otherwise share.
  schema: {},

  propsSchema: InstancePropsSchema,
  defaults: Value.Create(InstancePropsSchema),

  component: InstanceEditor,

  /** Publisher safety-net, same posture as `base.slot-instance`: never actually reached (studio-only), but must return empty per `publishBehavior: 'transparent'`'s registration-time validation. */
  render: () => ({ html: '', css: '' }),
}

registry.registerOrReplace(InstanceModule)
