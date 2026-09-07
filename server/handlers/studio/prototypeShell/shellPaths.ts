/**
 * shellPaths — where the preview shell lives and what one of its files is.
 *
 * A two-declaration leaf, because both halves of the shell need it and neither
 * is the natural owner: `shellFiles.ts` writes the app, `canvasTemplate.ts`
 * writes the board renderer, and having either import the other for a string
 * constant made them a cycle. Same fix shape as moving `getActiveBoard` out of
 * `boardSlice.ts` into `boardsModel.ts` — a value two sides need belongs in a
 * leaf, not in whichever side happened to declare it first.
 */

/**
 * The directory, relative to the workspace root, that the whole shell lives in.
 *
 * Re-exported from `@core/page-parser` rather than declared here: the parse
 * pipeline has to know this name too, in order NOT to read the shell as the
 * user's app, and a second copy of the string is a second thing to forget.
 * See `isPrototypeShellPath` for what goes wrong when they disagree.
 */
export { PROTOTYPE_SHELL_DIR } from '@core/page-parser'

/** One file the shell ships, and where it goes. */
export interface ShellFile {
  /** POSIX path relative to the workspace root. */
  relPath: string
  contents: string
}
