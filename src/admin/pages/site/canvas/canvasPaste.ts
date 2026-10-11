/**
 * canvasPaste — what one ⌘V does, once the bridge has read the clipboard
 * (P5-A). `decideCanvasPaste` picks the meaning; this carries it out through
 * the paths that already exist for each kind of content:
 *
 *   - LAYERS: the clipboard slice's `pasteNode(selection, 'after')` — `K7`'s
 *     placement and P3-D's source write (cross-frame paste carries the
 *     verbatim JSX, and ⌘Z takes it back), unchanged;
 *   - RASTER IMAGES: `insertImagesAtTarget`, which is the OS file drop's own
 *     write (`dropImagesIntoPage`, P5-B): the asset landing, one insert of N
 *     siblings, the ghost, the size clamp. No second image pipeline;
 *   - SVG: `insertSvgAtTarget` (`canvasSvgInsert.ts`, shared with the icon
 *     insert and the `.svg` drop): one subtree insert when it fits as source,
 *     an `<img>` of the landed file when it is too big, a refusal otherwise;
 *   - HTML (G-10): `writeHtmlToSource` - converted to intrinsic JSX (sanitized
 *     first, no scripts, no handlers, no `javascript:` links), its styles written
 *     into the page's own stylesheet, all of it one undo step.
 *
 * Images and SVGs land where ⇧K's images land (`canvasSelectionInsert.ts`):
 * after the selected layer, else at the end of the active frame's root.
 */
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { decideCanvasPaste, type ClipboardSnapshot } from './canvasClipboardData'
import { insertImagesAtTarget, readSelectionInsertTarget, type SelectionInsertTarget } from './canvasSelectionInsert'
import { insertSvgAtTarget } from './canvasSvgInsert'

type InsertTarget = Extract<SelectionInsertTarget, { ok: true }>

const PASTE_TITLE = 'Cannot paste that'

export function runCanvasPaste(snapshot: ClipboardSnapshot): void {
  const state = useEditorStore.getState()
  const decision = decideCanvasPaste(snapshot, state.clipboardEntry?.copiedAt ?? null)
  switch (decision.kind) {
    case 'nodes':
      // `K7` — 'after', not 'auto': ⌘V is a gesture about the SELECTION, and
      // the eye expects the copy beside the selected element rather than
      // appended to the end of its children. The right-click "Paste here"
      // keeps 'auto'. With nothing selected there is no position to name.
      if (state.selectedNodeId) state.pasteNode(state.selectedNodeId, 'after')
      return
    case 'images': {
      const target = targetOrExplain()
      if (target) insertImagesAtTarget(target, decision.files.map((file) => ({ kind: 'file', file })))
      return
    }
    case 'svg': {
      const target = targetOrExplain()
      if (target) void insertSvgAtTarget(decision.source, target, { undoLabel: 'Paste SVG', refusalTitle: 'Cannot paste that SVG' })
      return
    }
    case 'html': {
      const target = targetOrExplain()
      if (!target) return
      // A refusal has already been shown by the store, where it knew why.
      const written = state.writeHtmlToSource(decision.html, target.parentId, { index: target.index, undoLabel: 'Paste HTML' })
      if (written.kind === 'cms') {
        pushToast({
          kind: 'warning',
          title: PASTE_TITLE,
          body: 'This frame is not backed by a source file, so there is nowhere to write the pasted HTML. Paste into a frame that has a file.',
          location: 'site-editor',
        })
      }
      return
    }
    case 'none':
      if (decision.reason === 'foreign-marker') {
        pushToast({
          kind: 'info',
          title: 'Copied in another tab',
          body: 'The clipboard holds layers copied in another Studio tab. Copy them again here to paste them.',
          location: 'site-editor',
          dedupeKey: 'canvas-paste:foreign-marker',
        })
      } else if (decision.reason === 'unreadable') {
        pushToast({
          kind: 'warning',
          title: PASTE_TITLE,
          body: 'The browser did not let Studio read the clipboard. Allow clipboard access for this site.',
          location: 'site-editor',
          dedupeKey: 'canvas-paste:unreadable',
        })
      }
  }
}

/** The selection's insert position — resolved NOW, before any await can let the selection move. */
function targetOrExplain(): InsertTarget | null {
  const target = readSelectionInsertTarget()
  if (target.ok) return target
  pushToast({ kind: 'warning', title: PASTE_TITLE, body: target.message, location: 'site-editor' })
  return null
}
