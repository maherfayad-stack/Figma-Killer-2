import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * `studio.slot` (E2.3) — no stored props. The node exists only to give a
 * FRAGMENT-valued component prop (`header={<><A/><B/></>}`) a real, writable
 * container in the flat page tree — see `src/modules/studio/slot/index.ts`'s
 * doc comment. Every editable fact about the slot's content lives on its
 * `children`, not here, exactly like `studio.instance`'s `InstancePropsSchema`
 * carries no layout-relevant prop either.
 */
export const SlotPropsSchema = Type.Object({})

export type SlotStoredProps = Static<typeof SlotPropsSchema>
