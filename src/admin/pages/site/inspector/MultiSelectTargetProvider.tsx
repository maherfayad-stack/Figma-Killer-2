/**
 * MultiSelectTargetProvider — holds the multi-selection's chosen write target
 * for as long as the inspector surface stays mounted.
 *
 * Its own file (not `multiSelectTarget.ts`) because
 * `react-refresh/only-export-components` forbids mixing a component with the
 * plain `createContext`/hook exports that file owns.
 *
 * Mounted in `PropertiesPanelBody`, ABOVE `StyleSurface`, so the surface's own
 * `useSelectionModel()` call resolves the same target its sections do.
 */
import { useState, type ReactNode } from 'react'
import { MultiSelectTargetContext } from './multiSelectTarget'

export function MultiSelectTargetProvider({ children }: { children: ReactNode }) {
  const [classId, setClassId] = useState<string | null>(null)
  return (
    <MultiSelectTargetContext.Provider value={{ classId, setClassId }}>
      {children}
    </MultiSelectTargetContext.Provider>
  )
}
