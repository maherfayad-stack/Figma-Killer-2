/**
 * styleRule slice — transient editor UI state: which class the Class Composer
 * edits, inline-style editing mode, and the two canvas hover previews.
 *
 * These fields live on editor state (not the SiteDocument), so they are set
 * via the raw `set` helper and never push undo history.
 *
 * Guideline #242 — no-op guard: every setter bails out when the new value
 * equals the current value to prevent re-render loops.
 */

import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { shallowEqualStyles } from './helpers'

type UiStateActions = Pick<
  StyleRuleSlice,
  | 'setActiveClass'
  | 'setInlineStyleEditing'
  | 'setPreviewNodeClass'
  | 'clearPreviewNodeClass'
  | 'setPreviewClassStyles'
  | 'clearPreviewClassStyles'
  | 'setPreviewNodeStyles'
  | 'clearPreviewNodeStyles'
>

export function createUiStateActions({ set, get }: SiteSliceHelpers): UiStateActions {
  return {
    // Track F1 / S6 — `activeClassId` and `inlineStyleEditing` used to be
    // mutually exclusive: picking a class force-cleared inline-edit mode and
    // vice versa, so a user had to delete a class to even SEE their inline
    // styles. That coupling was the feature request in reverse — Studio's
    // panel shows BOTH targets simultaneously now (`StyleSurface`), each with
    // its own honest write-back outcome, so the two flags are independent
    // pieces of UI state: "which class is open for editing" and "is the
    // inline-style section open", not one exclusive mode switch.
    setActiveClass(id) {
      const { activeClassId } = get()
      // Guideline #242 no-op guard.
      if (Object.is(activeClassId, id)) return
      set((s) => {
        s.activeClassId = id
      })
    },

    setInlineStyleEditing(active) {
      if (get().inlineStyleEditing === active) return
      set((s) => {
        s.inlineStyleEditing = active
      })
    },

    setPreviewNodeClass(nodeId, classId) {
      const current = get().previewClassAssignment
      if (current?.nodeId === nodeId && current.classId === classId) return
      set((s) => {
        s.previewClassAssignment = { nodeId, classId }
      })
    },

    clearPreviewNodeClass(nodeId, classId) {
      const current = get().previewClassAssignment
      if (!current) return
      if (nodeId !== undefined && current.nodeId !== nodeId) return
      if (classId !== undefined && current.classId !== classId) return
      set((s) => {
        s.previewClassAssignment = null
      })
    },

    setPreviewClassStyles(preview) {
      const current = get().previewClassStyles
      if (
        current &&
        current.classId === preview.classId &&
        (current.breakpointId ?? null) === (preview.breakpointId ?? null) &&
        shallowEqualStyles(current.styles, preview.styles)
      ) {
        return
      }
      set((s) => {
        s.previewClassStyles = preview
      })
    },

    clearPreviewClassStyles(classId) {
      const current = get().previewClassStyles
      if (!current) return
      if (classId !== undefined && current.classId !== classId) return
      set((s) => {
        s.previewClassStyles = null
      })
    },

    // Inline mirror of setPreviewClassStyles/clearPreviewClassStyles above —
    // same raw-`set`-no-history shape, keyed by node id(s) instead of a
    // classId (Rule 7, panel-22).
    setPreviewNodeStyles(preview) {
      const current = get().previewNodeStyles
      if (
        current &&
        current.nodeIds.length === preview.nodeIds.length &&
        current.nodeIds.every((id, i) => id === preview.nodeIds[i]) &&
        shallowEqualStyles(current.styles, preview.styles)
      ) {
        return
      }
      set((s) => {
        s.previewNodeStyles = preview
      })
    },

    clearPreviewNodeStyles(nodeId) {
      const current = get().previewNodeStyles
      if (!current) return
      if (nodeId !== undefined && !current.nodeIds.includes(nodeId)) return
      set((s) => {
        s.previewNodeStyles = null
      })
    },
  }
}
