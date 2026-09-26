/**
 * canvasSvgInsert — the ONE way SVG content becomes an element in a page
 * (P5-A's paste, P5-D SVG-5's icon insert and `.svg` file drop).
 *
 *   - When it fits as source, `svgToJsxNode` converts it — sanitised first by
 *     `sanitizeSvg` (P5-D part 1), then the converter's own refusals (remote
 *     `url()`, `on*`, per-insert id remapping) — and it is written as ONE
 *     `insert` whose `children` carry the whole subtree
 *     (`insertJsxSubtreeIntoPage`): one write, one undo step.
 *   - When it is too big to inline (the parser's 64 KB inline-svg cliff, or
 *     the converter's node/depth budget), the FILE lands through the image
 *     path as an `<img>` (`insertImagesAtTarget`), whose bytes the server's
 *     `sanitizeSvgBytes` cleans — with a toast saying so. `asImage` asks for
 *     that route directly (⌥ on a `.svg` drop).
 *   - Any other refusal (malformed, not an svg, an unresolvable `<style>`, a
 *     remote reference) stays a refusal with the converter's own sentence:
 *     writing the same bytes somewhere else would not make them acceptable.
 *
 * Three callers used to be one (`canvasPaste.ts` held this); a second copy
 * for icons and drops is exactly how the paste and the drop would come to
 * disagree about what a large or hostile SVG becomes.
 */
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'
import type { ClipboardSvgSource } from './canvasClipboardData'
import { insertImagesAtTarget, type SelectionInsertTarget } from './canvasSelectionInsert'

export type SvgInsertTarget = Extract<SelectionInsertTarget, { ok: true }>

/**
 * Markup longer than this is not even offered to the converter: it lands as
 * an image file. The parser's own ceiling for an inline `<svg>`
 * (`inlineSvg.ts`'s `MAX_MARKUP_LENGTH`) is 64 KB, and a subtree written past
 * it would come back from the resync LOCKED — so this is the size at which
 * inlining stops being honest, not a taste.
 */
export const INLINE_SVG_MAX_CHARS = 64 * 1024

export interface SvgInsertWords {
  /** What ⌘Z names this step. */
  undoLabel: string
  /** The refusal toast's title. */
  refusalTitle: string
}

/** Insert `source` at `target`: inline when it fits, as an `<img>` file when too large (or `asImage`), else refused by name. */
export async function insertSvgAtTarget(
  source: ClipboardSvgSource,
  target: SvgInsertTarget,
  words: SvgInsertWords,
  options: { asImage?: boolean } = {},
): Promise<void> {
  // An oversized SVG FILE goes straight to the file route: it is never read
  // into memory just to be measured (review #270, N4).
  if (source.kind === 'file' && (options.asImage || source.file.size > INLINE_SVG_MAX_CHARS)) {
    landSvgAsImage(source.file, target, options.asImage === true)
    return
  }
  let markup: string
  try {
    markup = source.kind === 'text' ? source.markup : await source.file.text()
  } catch (err) {
    console.error('[canvas-svg-insert] reading the SVG failed:', err)
    pushToast({
      kind: 'warning',
      title: words.refusalTitle,
      body: 'Studio could not read that SVG. Try again, or drop the file onto a frame.',
      location: 'site-editor',
    })
    return
  }

  if (!options.asImage && markup.length <= INLINE_SVG_MAX_CHARS) {
    const converted = svgToJsxNode(markup)
    if (converted.ok) {
      useEditorStore.getState().insertJsxSubtreeIntoPage({
        pageId: target.pageId,
        parentId: target.parentId,
        index: target.index,
        node: converted.node,
        undoLabel: words.undoLabel,
      })
      return
    }
    if (converted.reason !== 'too-large') {
      pushToast({ kind: 'warning', title: words.refusalTitle, body: converted.message, location: 'site-editor' })
      return
    }
  }

  const file = source.kind === 'file' ? source.file : new File([markup], 'pasted.svg', { type: 'image/svg+xml' })
  landSvgAsImage(file, target, options.asImage === true)
}

/** The SVG as a file, through the drop's image path, as an `<img>`. */
function landSvgAsImage(file: File, target: SvgInsertTarget, asked: boolean): void {
  if (!asked) {
    pushToast({
      kind: 'info',
      title: 'Large SVG added as an image',
      body: 'It is too big to write into your source as inline SVG, so it was saved to your project and added as an <img>.',
      location: 'site-editor',
    })
  }
  insertImagesAtTarget(target, [file])
}
