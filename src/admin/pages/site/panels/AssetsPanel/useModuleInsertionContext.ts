import { isTemplatePage, treeHasOutlet } from '@core/templates'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { ModuleInsertionContext } from './assetsModel'

/**
 * The insertion context for the active canvas document — feeds
 * `moduleAvailability` so every picker surface (the Assets panel, the DOM
 * panel's context-menu picker, the notch's favourites) applies identical
 * hidden/disabled rules.
 */
export function useModuleInsertionContext(): ModuleInsertionContext {
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const isVCMode = activeDocument?.kind === 'visualComponent'
  return {
    isVCMode,
    activeVcId: activeDocument?.kind === 'visualComponent' ? activeDocument.vcId : null,
    isTemplate: !isVCMode && canvasPage !== null && isTemplatePage(canvasPage),
    hasOutlet: canvasPage !== null && treeHasOutlet(canvasPage),
  }
}
