/**
 * Editor commands — Save, Undo, Redo.
 * §4.2 of the Command Spotlight master plan.
 *
 * All commands are gated to workspace: ['site'] only.
 * Undo/redo use useEditorStore.getState() (Zustand getState is safe outside React).
 *
 * Save runs OUTSIDE React (the palette row can be clicked from anywhere), so it
 * can't call `usePersistence`'s `saveSite` directly — that callback only exists
 * inside the mounted hook. It goes through `flushEditorSave()`
 * (`@site/hooks/editorSaveRef`), the same cross-boundary bridge the MCP
 * editor-bridge uses to flush a pending draft after a tool call: `usePersistence`
 * registers its real `saveCurrentSite` there on mount, so this command rides the
 * exact pipeline Cmd+S does — `fsCodemodAdapter`, dirty-snapshot hints, the
 * single-flight save queue, and `hasUnsavedChanges` cleared only on a confirmed
 * write. (Cmd+S itself is "component-owned" — see
 * `shortcutDispatch.ts`'s `COMPONENT_OWNED_SHORTCUTS` — and is handled by
 * `usePersistence`'s own keydown listener rather than this command; this
 * command is what actually runs when "Save" is invoked from the palette.)
 *
 * Publishing was removed from Studio: the user's repository on disk *is* the
 * published artifact, so there is no separate publish step or command here.
 */

import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import type { Command } from '../types'

/** Mirrors `SITE_WRITE_CAPABILITIES` — any holder can save a draft. */
const SITE_WRITE_CAPABILITIES = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
] as const

export function getEditorCommands(): Command[] {
  return [
    {
      id: 'editor.save',
      title: 'Save',
      subtitle: 'Save the current draft',
      group: 'editor',
      iconName: 'save-solid',
      keywords: ['save', 'draft', 'write'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          await flushEditorSave()
        } catch (err) {
          console.error('[spotlight] save failed:', err)
          pushToast({
            kind: 'error',
            title: 'Save failed',
            body: getErrorMessage(err, 'Could not save your changes'),
          })
        }
      },
    },
    {
      id: 'editor.undo',
      title: 'Undo',
      subtitle: 'Undo the last change',
      group: 'editor',
      iconName: 'undo',
      keywords: ['undo', 'revert', 'back'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      when: (ctx) => ctx.editor?.canUndo === true,
      priorityBoost: 1.2,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const { useEditorStore } = await import('@site/store/store')
        useEditorStore.getState().undo()
      },
    },
    {
      id: 'editor.redo',
      title: 'Redo',
      subtitle: 'Redo the last undone change',
      group: 'editor',
      iconName: 'redo',
      keywords: ['redo', 'forward'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      when: (ctx) => ctx.editor?.canRedo === true,
      priorityBoost: 1.2,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const { useEditorStore } = await import('@site/store/store')
        useEditorStore.getState().redo()
      },
    },
  ]
}
