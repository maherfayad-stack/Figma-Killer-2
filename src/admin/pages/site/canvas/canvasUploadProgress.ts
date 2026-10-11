/**
 * canvasUploadProgress — the canvas's {@link UploadProgressPainter}: an image
 * upload's progress written onto every rendered element of a node (the drop's
 * ghost, or the `<img>` a drop is replacing).
 *
 * A pure WRITE, once per XHR progress event — no measurement, so no layout
 * read to interleave with. React owns neither the attribute nor the custom
 * property, so a re-render leaves them alone; `EditorChromeInjector`'s
 * `img[data-studio-uploading]` rule turns the fraction into the mask.
 *
 * Lives on the canvas side and is handed to the store's image actions,
 * because the store must not import the frame-document machinery (that would
 * close an import cycle through `store.ts`).
 */
import {
  UPLOADING_ATTRIBUTE,
  UPLOAD_PROGRESS_PROPERTY,
  type UploadProgressPainter,
} from '@site/store/slices/site/imageDropShapes'
import { findRenderedCanvasElements } from './canvasNodeLookup'

export const paintCanvasUploadProgress: UploadProgressPainter = (nodeId, fraction) => {
  for (const { element } of findRenderedCanvasElements(nodeId)) {
    if (fraction === null) {
      element.removeAttribute(UPLOADING_ATTRIBUTE)
      element.style.removeProperty(UPLOAD_PROGRESS_PROPERTY)
    } else {
      element.setAttribute(UPLOADING_ATTRIBUTE, '')
      element.style.setProperty(UPLOAD_PROGRESS_PROPERTY, String(Math.max(0, Math.min(1, fraction))))
    }
  }
}
