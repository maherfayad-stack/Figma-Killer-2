/**
 * jsxClassTokens — a `className` written as an EXPRESSION: the CSS-Module
 * member (`styles.card`) a pasted element's class resolves to, alone or beside
 * the literal tokens it keeps (`` `${styles.card} lead` ``).
 *
 * G-10 (paste HTML as JSX). When pasted markup arrives with a `<style>` block
 * and the page's stylesheet is a CSS Module, the rules are written into that
 * file and the elements must reach them the way every other element of that
 * page does, through the module's default import. A string cannot say that, and
 * a bare identifier in a JSON prop is exactly the expression-injection sink
 * `jsxAssetImports.ts` already refuses to build — so this is a CLASS, like
 * `BoundAssetImport`: no JSON value is ever an instance, so a request body can
 * never put an expression into the user's file. Only the server's own paste
 * planner (`studioInsertHtmlStyles.ts`) constructs one, after it has read the
 * file and found the module's default import.
 *
 * Every part is validated at construction rather than at render: a binding must
 * be an identifier, a literal token must hold nothing that can leave a template
 * literal (those characters are escaped, not trusted).
 */

/** A valid ES identifier — the binding a module's default import was written under. */
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export type ClassNamePart =
  /** A token written as is — a class the stylesheet does not define, or one from another file. */
  | { literal: string }
  /** `local` is the class as WRITTEN in the module file; `binding` is the file's default import of it. */
  | { module: { binding: string; local: string } }

export class ClassNameTokens {
  readonly parts: readonly ClassNamePart[]

  constructor(parts: readonly ClassNamePart[]) {
    for (const part of parts) {
      if ('module' in part && !BINDING.test(part.module.binding)) {
        throw new Error(`"${part.module.binding}" is not an identifier, so it cannot name a CSS Module import. Pick a plain identifier.`)
      }
    }
    this.parts = parts
  }

  /** The JS expression this className is — `styles.card`, `styles["lead-in"]`, or a template literal for several parts. */
  expression(): string {
    const only = this.parts.length === 1 ? this.parts[0] : undefined
    if (only && 'module' in only) return memberAccess(only.module)
    const pieces = this.parts.map((part) =>
      'module' in part ? `\${${memberAccess(part.module)}}` : escapeTemplateText(part.literal),
    )
    return `\`${pieces.join(' ')}\``
  }
}

function memberAccess({ binding, local }: { binding: string; local: string }): string {
  return BINDING.test(local) ? `${binding}.${local}` : `${binding}[${JSON.stringify(local)}]`
}

/** Text safe between the backticks of a template literal. */
function escapeTemplateText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}
