/**
 * The outcome of `writeHtmlToSource` - the store action behind pasting HTML
 * onto a board backed by real files (G-10). Its own module so `types.ts` can
 * name it without importing the writer, which imports the structural-edit
 * planner that imports the slice helpers that import `types.ts`.
 */
import type { HtmlToJsxReport } from '@site/studio/htmlToJsxReport'
import type { AbsoluteImagePlacement } from './imageDropShapes'

export type HtmlSourceWriteResult =
  /** An ordinary CMS tree: nothing was done, the caller imports the HTML into the tree as before. */
  | { kind: 'cms' }
  /** The write is posted. `report` is what the conversion left out of the markup. */
  | { kind: 'written'; report: HtmlToJsxReport }
  /** Refused out loud; `message` is the sentence the user was shown. */
  | { kind: 'refused'; message: string }

export interface PasteHtmlOptions {
  /** Insert position within the parent's children; appended when omitted. */
  index?: number
  /** What ⌘Z names this step. */
  undoLabel?: string
  /**
   * The parent is a free frame (no flow to land in): pin each pasted root at
   * these insets, cascading by one step per root, instead of leaving it at the
   * frame's (0,0).
   */
  absolute?: AbsoluteImagePlacement | null
}
