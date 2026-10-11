/**
 * refusalCopy — the sentences more than one refusal says, said once.
 *
 * A refusal is two sentences at most: what is true, then the one thing to do.
 * `src/__tests__/architecture/refusal-copy-shape.test.ts` measures every
 * refusal in the repository against that shape, and reads the constants below
 * too, so a codemod that says "the file changed" says it the same way as the
 * writeback in front of it.
 *
 * Only sentences that several refusals share live here. A refusal that names
 * its own file, binding or prop writes its own sentence next to the code that
 * decides it.
 */

/** The file on disk is not the file the board read. Every writer's compare-and-swap ends here. */
export const STALE_SOURCE_MESSAGE = 'The file changed on disk since the board read it. Reload the project and try again.'

/** The element a write was aimed at is not at its recorded line and column any more. */
export const ELEMENT_GONE_MESSAGE = 'That element is no longer where the board read it. Reload the project and try again.'

/** The write itself would break the file, so it was not made. */
export const SYNTAX_REGRESSION_MESSAGE = 'This change would leave the file with a syntax error. Make it in the code instead.'

/**
 * A name the new place cannot see. It names them, because "some binding" is not
 * something a person can act on. Move, copy and group share it: the sentence is
 * about where the element would land, not about the gesture that took it there.
 */
export function outOfScopeMessage(names: readonly string[]): string {
  const list = names.map((name) => `\`${name}\``).join(', ')
  return `This element reads ${list} from the code around it, which is not in scope where it would land. Keep it inside the same component.`
}
