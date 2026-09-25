/**
 * Image commands — IX-img's "Insert image…": a file picker whose images land
 * beside the selection, through the same write an OS file drop makes
 * (`canvasImagePicker.ts`). Penpot and Figma bind it to ⇧K / ⇧⌘K; this is the
 * command the binding will name (`insert.image`), reachable from the palette
 * until then.
 *
 * Capability: inserting an element is a structural edit.
 */
import type { Command } from '../types'

export function getImageCommands(): Command[] {
  return [
    {
      id: 'insert.image',
      title: 'Insert image…',
      subtitle: 'Pick image files and add them beside the selection',
      group: 'editor',
      iconName: 'image-solid',
      keywords: ['image', 'picture', 'photo', 'upload', 'insert', 'place', 'img'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      run: async (ctx) => {
        ctx.closeSpotlight()
        // Lazy, like every editor command: keeps the editor store out of
        // non-site bundles. The dynamic import resolves well inside the
        // browser's user-activation window, so the file dialog still opens.
        const { pickImagesIntoSelection } = await import('@site/canvas/canvasImagePicker')
        pickImagesIntoSelection()
      },
    },
  ]
}
