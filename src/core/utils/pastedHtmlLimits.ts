/**
 * The size a pasted HTML fragment may have (G-10), in ONE place because two
 * sides enforce it and must agree: the editor's converter (`htmlToJsx.ts`)
 * refuses early with a sentence, and the server re-checks what arrives
 * (`studioInsertHtmlStyles.ts`) because a request body is not the editor.
 *
 * A paste is one splice into one file and one undo step; a whole site's markup
 * is neither readable in that file nor a gesture anyone meant. These bound the
 * work, not the taste: past them the answer is "paste a section at a time".
 */

/** Characters of HTML the editor will convert. */
export const MAX_PASTED_HTML_CHARS = 512 * 1024
/** Elements (text-run spans included) one paste may write. */
export const MAX_PASTED_ELEMENTS = 1500
/** How deep the pasted tree may nest. */
export const MAX_PASTED_DEPTH = 40
/** Characters one prop value may carry (an inline `data:` image is the largest honest one); enforced by the wire schema BEFORE the recursive walk. */
export const MAX_PROP_TEXT_CHARS = 256 * 1024
/** Characters of `<style>` text that may travel with a paste. */
export const MAX_PASTED_CSS_CHARS = 256 * 1024
