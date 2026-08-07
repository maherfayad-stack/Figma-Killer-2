/**
 * `studio.slot` editor preview component (E2.3).
 *
 * Renders literally `<>{children}</>` — a React Fragment, zero DOM elements.
 * Copied verbatim (structure, not just intent) from
 * `src/modules/base/instance/InstanceEditor.tsx`, which this module mirrors
 * one-for-one: a `studio.instance` node exists so a component CALL SITE has
 * a real, addressable node without leaving a DOM wrapper behind; a
 * `studio.slot` node exists so a FRAGMENT-valued slot prop
 * (`header={<><A/><B/></>}`) has one too. Same invariant, same reason — see
 * that file's doc comment for the full "why not `display: contents`" case
 * (percentage/flex height chains, `>`/`+`/`:nth-child` combinators crossing
 * the node). A wrapper `<div>` here would corrupt every measurement, drop
 * target, and fidelity comparison for a slot exactly the way it would for an
 * instance — trap #1 in `PROJECT-BRIEF.md` §6.
 *
 * `nodeWrapperProps` is deliberately NOT spread here, for the same reason
 * `InstanceEditor` omits it: a Fragment cannot carry props. Selection
 * geometry still resolves through `nodeVisualRect`'s box-less-node fallback
 * (union of children), the same mechanism that already covers
 * `studio.instance` and the `display: contents` design-system host.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import type { SlotStoredProps } from './props'

export const SlotEditor: React.FC<ModuleComponentProps<SlotStoredProps>> = ({ children }) => {
  return <>{children}</>
}
