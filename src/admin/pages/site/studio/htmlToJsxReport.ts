/**
 * What `htmlToJsx` left out of a pasted fragment. Its own leaf so the store's
 * slice types can name it (`htmlSourceWriteResult.ts`) without importing the
 * converter, which imports the SVG importer and the sanitizer.
 */
export interface HtmlToJsxReport {
  /** `<script>` elements removed. */
  scripts: number
  /** `on*` attributes removed. */
  handlers: number
  /** `javascript:` / `vbscript:` / non-image `data:` URLs removed. */
  unsafeUrls: number
  /** Inline `style` declarations removed (an external resource, or a value the CSS sanitizer refuses). */
  styleDeclarations: number
  /** One sentence per `<svg>` that was not written, and why. */
  svgRefusals: string[]
}
