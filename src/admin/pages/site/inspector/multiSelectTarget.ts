/**
 * MultiSelectTargetContext — which write target a MULTI-selection is aimed
 * at, shared between the chip that changes it and the model every section
 * reads (`docs/features/inspector.md` §9.4).
 *
 * Why a context and not a `SelectionModel` field: the answer is panel STATE,
 * not a fact about the selection. `useSelectionModel` is a pure derivation
 * from the store; "the user clicked the `.card` chip and cleared its
 * blast-radius gate" is neither in the store (it must not survive a reload or
 * leak into undo) nor derivable from the nodes. Threading it as a prop is not
 * available either — every `INSPECTOR_SECTIONS` entry is a bare, prop-less
 * `<Component />` by design, so a context read is the only way the model can
 * answer the same question for all of them at once.
 *
 * `classId: null` is Element (inline), the default and the only target when
 * the selection shares no class. The provider lives in
 * `PropertiesPanelBody`, ABOVE `StyleSurface`, so the surface's own
 * `useSelectionModel()` call sees the same target its sections do.
 */
import { createContext, useContext } from 'react'

export interface MultiSelectTarget {
  /** The shared class every commit should land on, or `null` for inline. */
  classId: string | null
  setClassId(classId: string | null): void
}

const ELEMENT_TARGET: MultiSelectTarget = {
  classId: null,
  // Outside a provider there is no multi-selection surface to retarget —
  // every consumer is already rendering the single-node path.
  setClassId: () => {},
}

export const MultiSelectTargetContext = createContext<MultiSelectTarget>(ELEMENT_TARGET)

export function useMultiSelectTarget(): MultiSelectTarget {
  return useContext(MultiSelectTargetContext)
}
