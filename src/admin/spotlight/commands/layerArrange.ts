/**
 * Layer arrange commands (P5-E) — align, bring to front / send to back, flex
 * layout, copy / paste style, in the palette.
 *
 * Each runs the SAME function its key and its right-click item run
 * (`canvas/layerAlign.ts`, `canvas/layerCommands.ts`), imported lazily like
 * every other editor command so the palette does not pull the canvas into
 * its own chunk. The keys are component-owned (`shortcutDispatch.ts`), so a
 * press never runs these AND the canvas handler.
 */
import type { Command } from '../types'
import { ALIGN_COMMANDS } from '../keybindingLayerCommands'

const hasSelection = (ctx: { editor?: { selectedNodeIds: ReadonlyArray<string> } }) =>
  (ctx.editor?.selectedNodeIds.length ?? 0) > 0

function layerCommand(
  id: string,
  title: string,
  subtitle: string,
  keywords: string[],
  run: () => Promise<void>,
): Command {
  return {
    id,
    title,
    subtitle,
    group: 'editor',
    keywords: ['layer', ...keywords],
    workspaces: ['site'],
    capability: 'site.structure.edit',
    when: hasSelection,
    run: async (ctx) => {
      ctx.closeSpotlight()
      try {
        await run()
      } catch (err) {
        console.error(`[spotlight] ${id} failed:`, err)
      }
    },
  }
}

export function getLayerArrangeCommands(): Command[] {
  return [
    ...ALIGN_COMMANDS.map(({ commandId, edge, label }) =>
      layerCommand(commandId, label, 'Align the selected layers', ['align', edge], async () => {
        const { alignSelection } = await import('@site/canvas/layerAlign')
        await alignSelection(edge)
      }),
    ),
    layerCommand('layers.bringToFront', 'Bring to front', 'Move the layer last in its parent — it paints on top', ['front', 'z-order', 'arrange', 'top'], async () => {
      const { moveSelectionToEnd } = await import('@site/canvas/layerCommands')
      moveSelectionToEnd('front')
    }),
    layerCommand('layers.sendToBack', 'Send to back', 'Move the layer first in its parent — it paints underneath', ['back', 'z-order', 'arrange', 'bottom'], async () => {
      const { moveSelectionToEnd } = await import('@site/canvas/layerCommands')
      moveSelectionToEnd('back')
    }),
    layerCommand('layers.toggleFlexLayout', 'Add flex layout', 'Lay the container out with flexbox (again removes it)', ['flex', 'auto layout', 'layout', 'row', 'column'], async () => {
      const { toggleFlexLayout } = await import('@site/canvas/layerCommands')
      await toggleFlexLayout()
    }),
    layerCommand('layers.copyStyle', 'Copy style', 'Copy the layer’s style and classes', ['copy', 'style', 'properties'], async () => {
      const { copySelectionStyle } = await import('@site/canvas/layerCommands')
      copySelectionStyle()
    }),
    layerCommand('layers.pasteStyle', 'Paste style', 'Paste the copied style onto the selected layers', ['paste', 'style', 'properties'], async () => {
      const { pasteSelectionStyle } = await import('@site/canvas/layerCommands')
      pasteSelectionStyle()
    }),
  ]
}
