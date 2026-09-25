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
 *   - SVG: `svgToJsxNode` (sanitised by P5-D part 1's `sanitizeSvg` before a
 *     node is read) and ONE subtree insert, when it fits as source; when it is
 *     too big to inline, the drop's image path again, as an `<img>` of the
 *     landed file (whose bytes the server's `sanitizeSvgBytes` cleans). Any
 *     other refusal — malformed, unsafe, a remote reference — stays a refusal:
 *     writing the same bytes somewhere else would not make them acceptable.
 *
 * Images and SVGs land where ⇧K's images land (`canvasSelectionInsert.ts`):
 * after the selected layer, else at the end of the active frame's root.
 */
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'
import { decideCanvasPaste, type ClipboardSnapshot, type ClipboardSvgSource } from './canvasClipboardData'
import { insertImagesAtTarget, readSelectionInsertTarget, type SelectionInsertTarget } from './canvasSelectionInsert'

type InsertTarget = Extract<SelectionInsertTarget, { ok: true }>

const PASTE_TITLE = 'Cannot paste that'

/**
 * Markup longer than this is not even offered to the converter: it lands as
 * an image file. The parser's own ceiling for an inline `<svg>`
 * (`inlineSvg.ts`'s `MAX_MARKUP_LENGTH`) is 64 KB, and a subtree written past
 * it would come back from the resync LOCKED — so this is the size at which
 * inlining stops being honest, not a taste.
 */
export const INLINE_SVG_MAX_CHARS = 64 * 1024

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
      if (target) insertImagesAtTarget(target, decision.files)
      return
    }
    case 'svg': {
      const target = targetOrExplain()
      if (target) void pasteSvg(decision.source, target)
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
          body: 'The browser did not let Studio read the clipboard. Allow clipboard access for this site, or drop the file onto a frame instead.',
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

async function pasteSvg(source: ClipboardSvgSource, target: InsertTarget): Promise<void> {
  let markup: string
  try {
    markup = source.kind === 'text' ? source.markup : await source.file.text()
  } catch (err) {
    console.error('[canvas-paste] reading the pasted SVG failed:', err)
    pushToast({ kind: 'error', title: PASTE_TITLE, body: 'Studio could not read the SVG on the clipboard.', location: 'site-editor' })
    return
  }

  if (markup.length <= INLINE_SVG_MAX_CHARS) {
    const converted = svgToJsxNode(markup)
    if (converted.ok) {
      useEditorStore.getState().insertJsxSubtreeIntoPage({
        pageId: target.pageId,
        parentId: target.parentId,
        index: target.index,
        node: converted.node,
        undoLabel: 'Paste SVG',
      })
      return
    }
    if (converted.reason !== 'too-large') {
      pushToast({ kind: 'warning', title: 'Cannot paste that SVG', body: converted.message, location: 'site-editor' })
      return
    }
  }

  const file = source.kind === 'file' ? source.file : new File([markup], 'pasted.svg', { type: 'image/svg+xml' })
  pushToast({
    kind: 'info',
    title: 'Large SVG added as an image',
    body: 'It is too big to write into your source as inline SVG, so it was saved to your project and added as an <img>.',
    location: 'site-editor',
  })
  insertImagesAtTarget(target, [file])
}
