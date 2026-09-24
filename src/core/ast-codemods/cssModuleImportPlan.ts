/**
 * cssModuleImportPlan — the CSS-Module `import`s a batch's class edits need,
 * added AFTER every edit in the batch has landed (P3-C, WB-18).
 *
 * `setJsxClassName` attaches a CSS-Module class as a binding (`styles.row`).
 * When the file did not import that stylesheet yet it used to REFUSE
 * (`css-module-import-missing`): adding the `import` line mid-batch would move
 * every other pending edit's `line:col` in the file — the exact hazard
 * `orderStudioEditsForApply` exists to prevent. The refusal named the fix and
 * left the user to do it by hand. The answer `pruneOrphanedImports` already
 * gives a delete works here too: the codemod writes `styles.row` against a
 * binding it RESERVES in this plan, and the import line is added once, after
 * the batch's last edit, when no pending position is left to move.
 *
 * One plan per file, one binding per stylesheet. A reservation is made only on
 * the codemod's WRITE path (an edit that refuses reserves nothing), so the plan
 * never adds an import that no written markup reads — which under
 * `noUnusedLocals` would be a build failure in the user's repo.
 */
import { applyTextEdits } from './jsxChildRange'
import { resolveImportEdits, type ImportRequirement } from './jsxImportEdits'
import { createProject, loadSourceFile } from './locateJsxElement'

/** Module specifier (as THIS file must spell it) → the default binding reserved for it. */
export type PendingModuleImports = Map<string, string>

export interface ModuleImportPlan {
  /** The reservations for one absolute file path — created on first ask. */
  forFile(file: string): PendingModuleImports
  /**
   * Writes every reserved import. Call once, after the batch's last edit. A
   * file whose import could not be written is returned in `failed` with the
   * lines it still needs — its markup already reads the binding, so the caller
   * must tell someone, never swallow it.
   */
  apply(): { written: string[]; failed: { file: string; imports: string[] }[] }
}

export function createModuleImportPlan(): ModuleImportPlan {
  const byFile = new Map<string, PendingModuleImports>()
  return {
    forFile(file) {
      let pending = byFile.get(file)
      if (!pending) {
        pending = new Map()
        byFile.set(file, pending)
      }
      return pending
    },
    apply() {
      const written: string[] = []
      const failed: { file: string; imports: string[] }[] = []
      for (const [file, pending] of byFile) {
        if (pending.size === 0) continue
        try {
          if (writeImports(file, pending)) written.push(file)
        } catch (err) {
          console.error('[ast-codemods/cssModuleImportPlan]', file, err)
          failed.push({ file, imports: [...pending].map(([specifier, binding]) => `import ${binding} from '${specifier}'`) })
        }
      }
      byFile.clear()
      return { written, failed }
    },
  }
}

/** Adds `pending`'s default imports to `file`; `false` when every one was already there. */
function writeImports(file: string, pending: PendingModuleImports): boolean {
  const sourceFile = loadSourceFile(createProject(), file)
  const text = sourceFile.getFullText()
  const required = new Map<string, ImportRequirement>(
    [...pending].map(([specifier, binding]) => [binding, { specifier, style: 'default' }]),
  )
  // A CRLF file gets CRLF import lines, not a mixed-ending one.
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const edits = resolveImportEdits(sourceFile, text, required).map((edit) => ({
    ...edit,
    text: eol === '\n' ? edit.text : edit.text.replace(/\n/g, eol),
  }))
  if (edits.length === 0) return false
  sourceFile.replaceWithText(applyTextEdits(text, edits))
  sourceFile.saveSync()
  return true
}
