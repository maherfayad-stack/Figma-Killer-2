/**
 * jsxTagKind — the one-character question every JSX walk in this codebase
 * asks about a tag name: does this identifier denote a host/intrinsic DOM
 * element, or a component?
 *
 * Extracted out of `parsePageFile.ts` (and de-duplicated with the identical
 * check `cssInJsAttach.ts` had grown independently) so a SECOND walker with no
 * ts-morph dependency — the Vite plugin in `@core/studio-runtime`, which reads
 * Babel's AST instead — can ask the exact same question the parser does. Two
 * classifiers that happen to agree today is how they silently stop agreeing
 * tomorrow; one function both sides call is the only way to keep them in
 * lockstep.
 */

export type JsxTagKind = 'element' | 'component'

/**
 * lowercase tag name = `'element'` (a host/intrinsic DOM tag, e.g. `div`,
 * `svg:title`); Capitalized = `'component'`.
 *
 * Checked on the FIRST character only, exactly as `parsePageFile` always has —
 * a `motion.div`-shaped dotted, lowercase-led name (framer-motion's
 * `motion.div`, `Menu.item`) is classified `'element'` here too, even though
 * it is a component reference. This is a pre-existing quirk of the rule this
 * extraction reproduces on purpose, not a bug to fix while moving the code:
 * changing it would change which nodes lock/inline/stamp across the whole
 * pipeline in one silent step, for repos nothing here has been measured
 * against.
 */
export function classifyJsxTagKind(name: string): JsxTagKind {
  return /^[A-Z]/.test(name) ? 'component' : 'element'
}
