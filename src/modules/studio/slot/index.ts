/**
 * `studio.slot` — E2.3's fragment-valued slot container.
 *
 * `captureSlotProps` (`src/core/page-parser/parsePageFile.ts`) materializes a
 * component prop's JSX value as a real child node so it round-trips through
 * the ordinary flat page tree instead of being dropped. A SINGLE-element
 * value (`icon={<Icon/>}`) already worked with zero parser change — it mints
 * one ordinary node. A FRAGMENT value (`header={<><Back/><Title/></>}`) has
 * no single element to mint, so it gets this module instead: one real node,
 * at the fragment's OWN source location (never a minted id — see
 * `sourceStructure.ts`'s `refuseMintedNodeInsert`, which must see a real
 * source-derived id here or every future insert into a multi-element slot
 * would be refused for the wrong reason), whose `children` are the
 * fragment's own JSX children.
 *
 * Renders as a bare React Fragment (`SlotEditor`) — **zero DOM elements** —
 * copying `studio.instance` (`src/modules/base/instance/`) verbatim: the
 * canvas DOM must stay exactly the DOM React renders, or every measurement,
 * drop target, and fidelity comparison downstream is corrupted (trap #1,
 * `PROJECT-BRIEF.md` §6). `studio.instance` exists for the identical reason
 * one level up — a component CALL SITE that must not leave a wrapper behind;
 * this is the same fix for a SLOT VALUE.
 *
 * Studio-only, no publisher representation — same `publishBehavior:
 * 'transparent'` posture as `studio.instance`/`base.slot-instance` (Studio
 * boards are not published; the filesystem is the source of truth).
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { Value } from '@core/utils/typeboxHelpers'
import { SlotEditor } from './SlotEditor'
import { SlotPropsSchema, type SlotStoredProps } from './props'

export const SlotModule: ModuleDefinition<SlotStoredProps> = {
  id: 'studio.slot',
  name: 'Slot',
  description: 'A fragment-valued component-prop slot',
  category: 'Components',
  version: '1.0.0',
  icon: BoxStackSolidIcon,
  trusted: true,
  canHaveChildren: true,

  // Renders no element of its own — see `SlotEditor`'s doc comment.
  // Nothing to publish (studio-only, see this file's own header).
  publishBehavior: 'transparent',

  // No declarative schema: the node carries no editable prop of its own —
  // every editable fact lives on its children.
  schema: {},

  propsSchema: SlotPropsSchema,
  defaults: Value.Create(SlotPropsSchema),

  component: SlotEditor,

  /** Publisher safety-net, same posture as `studio.instance`: never actually reached (studio-only), but must return empty per `publishBehavior: 'transparent'`'s registration-time validation. */
  render: () => ({ html: '', css: '' }),
}

registry.registerOrReplace(SlotModule)
