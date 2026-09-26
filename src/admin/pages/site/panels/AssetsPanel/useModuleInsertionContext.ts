import { isTemplatePage, treeHasOutlet } from '@core/templates'
import { selectActiveCanvasPage, useEditorStore, type EditorStore } from '@site/store/store'
import type { ModuleInsertionContext } from './assetsModel'

/**
 * `treeHasOutlet` walks a tree's nodes. A tree's `nodes` map is replaced on
 * every edit and never mutated, so the answer is kept per map: one walk per
 * edit, not one per store change.
 */
const outletByNodes = new WeakMap<object, boolean>()

function activePageHasOutlet(state: EditorStore): boolean {
  const page = selectActiveCanvasPage(state)
  if (!page) return false
  let answer = outletByNodes.get(page.nodes)
  if (answer === undefined) {
    answer = treeHasOutlet(page)
    outletByNodes.set(page.nodes, answer)
  }
  return answer
}

function activePageIsTemplate(state: EditorStore): boolean {
  if (state.activeDocument?.kind === 'visualComponent') return false
  const page = selectActiveCanvasPage(state)
  return page !== null && isTemplatePage(page)
}

/**
 * The insertion context for the active canvas document — feeds
 * `moduleAvailability` so every picker surface (the Assets panel, the DOM
 * panel's context-menu picker, the notch's favourites) applies identical
 * hidden/disabled rules.
 *
 * Four primitive subscriptions, never the page object (P6-C): the page is a
 * new object after every keystroke, and a context rebuilt from it re-rendered
 * every asset card on the panel while the user typed.
 */
export function useModuleInsertionContext(): ModuleInsertionContext {
  const isVCMode = useEditorStore((s) => s.activeDocument?.kind === 'visualComponent')
  const activeVcId = useEditorStore((s) => (s.activeDocument?.kind === 'visualComponent' ? s.activeDocument.vcId : null))
  const isTemplate = useEditorStore(activePageIsTemplate)
  const hasOutlet = useEditorStore(activePageHasOutlet)
  return { isVCMode, activeVcId, isTemplate, hasOutlet }
}
