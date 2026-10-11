/**
 * syntaxRegression — "did this rewrite make the file parse WORSE than it
 * did?", the last guard a codemod that rewrites markup in memory runs before
 * it saves (`detachComponent.ts`).
 *
 * A global COUNT of syntactic diagnostics, candidate against original — so it
 * never stands alone as a shape check (a diagnostic-clean file makes 0-vs-0
 * trivial to satisfy); it catches a rewrite that is well-formed in isolation
 * but wrong where it landed. Syntactic only: a JSX file legitimately carries
 * semantic diagnostics (unresolved imports, `noUnusedLocals`) a codemod has no
 * business judging.
 *
 * A throwaway in-memory `Project`, never the caller's: parsing a bad candidate
 * must not leave the caller's project holding a broken tree for whatever edit
 * runs after this one in the same batch.
 */
import { Project } from 'ts-morph'

/** True when `candidate` carries syntactic diagnostics `original` did not. */
export function introducesSyntaxErrors(file: string, original: string, candidate: string): boolean {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  // Two distinct filenames in one throwaway project (never `file` itself,
  // which would collide with whatever the real, disk-backed project holds),
  // both keeping `file`'s own extension so a `.jsx` candidate is parsed with
  // JSX support rather than silently downgraded.
  const ext = /\.[cm]?[jt]sx?$/.exec(file)?.[0] ?? '.tsx'
  const beforeFile = scratch.createSourceFile(`before${ext}`, original)
  const afterFile = scratch.createSourceFile(`after${ext}`, candidate)
  const program = scratch.getProgram()
  return program.getSyntacticDiagnostics(afterFile).length > program.getSyntacticDiagnostics(beforeFile).length
}
