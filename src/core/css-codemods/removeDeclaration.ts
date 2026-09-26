/**
 * removeDeclaration — the missing half of `setDeclaration`.
 *
 * ## Why it exists (`style-03`)
 *
 * The save diff only ever iterated the properties a rule has NOW, and
 * `setDeclaration` only ever sets a value. Clearing a declaration in the
 * inspector therefore produced no edit at all: the canvas updated, autosave
 * ran, the file was untouched, and the property came straight back on the next
 * reload — with nothing said. That is the same silent-loss shape the `unmapped`
 * refusal exists to prevent, one level down: not "we cannot write this", but
 * "we did not even look".
 *
 * A CST round-trip via `postcss`, exactly like its sibling: parse, remove
 * declaration nodes, `.toString()`. Every byte this codemod did not touch
 * round-trips verbatim through postcss's `raws`.
 *
 * ## Every declaration of it, so the class stops setting it (P3-C, WB-16)
 *
 * This used to remove the FIRST declaration in the FIRST matching rule, and
 * `analyzeDeclarationTarget` refused a removal whenever a second one existed —
 * a later block, or the property twice in one block — because removing the
 * first left the second in effect: the file changed and the canvas did not.
 * The honest reading of "clear this property from the class" is every
 * declaration of it the scope's matching rules carry, and that is one edit. A
 * covering SHORTHAND stays (clearing `padding-top` is not clearing `padding`);
 * whatever it then shows is what the canvas shows too.
 *
 * ## What it cleans up, and what it does not
 *
 * A rule left with NO nodes at all is removed too — `.card {}` is dead text
 * that says nothing, and leaving it behind would make "clear every property"
 * accumulate empty blocks over a session. A rule still holding a comment keeps
 * its block, because a comment is a node and the user wrote it. Emptying the
 * last rule inside a conditional block removes the block for the same reason.
 *
 * A property that is simply absent is `changed: false`, never an error:
 * re-sending an already-applied removal on a later autosave tick must be a
 * no-op.
 */
import { preservingLineEndings } from './preserveLineEndings'
import { readDeclarationScope, type DeclarationWriteOptions, type DeclarationWriteRefusal, type DeclarationWriteResult } from './setDeclaration'

/**
 * Remove every declaration of `property` from the rules matching `selector` in
 * the scope `options.atRule` names (the unconditional rules when omitted). See
 * this module's doc.
 */
export function removeDeclaration(
  cssText: string,
  selector: string,
  property: string,
  options: DeclarationWriteOptions = {},
): DeclarationWriteResult {
  let refusal: DeclarationWriteRefusal | null = null
  const rewrite = preservingLineEndings(cssText, (source) => {
    const read = readDeclarationScope(source, options)
    if ('refusal' in read) {
      refusal = read.refusal
      return { css: source, changed: false }
    }
    const target = selector.trim()
    const prop = property.toLowerCase()
    let changed = false
    for (const container of read.containers) {
      container.each((node) => {
        if (node.type !== 'rule' || node.selector.trim() !== target) return
        node.each((child) => {
          if (child.type === 'decl' && child.prop.toLowerCase() === prop) {
            child.remove()
            changed = true
          }
        })
        if (node.nodes.length === 0) node.remove()
      })
    }
    if (!changed) return { css: source, changed: false }
    for (const container of read.containers) {
      if (container !== read.root && (container.nodes?.length ?? 0) === 0) container.remove()
    }
    return { css: read.root.toString(), changed: true }
  })
  return refusal ? { ok: false, refusal } : { ok: true, ...rewrite }
}
