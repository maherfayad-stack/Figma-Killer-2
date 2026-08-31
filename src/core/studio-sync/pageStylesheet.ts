/**
 * pageStylesheet — the identity of one stylesheet discovered by the Studio
 * import pipeline's §6.1 walk.
 *
 * This lives in its own leaf module, rather than beside the walk that produces
 * it, because both `collectPageStylesheets` (the producer) and
 * `entryStylesheetCache` (which memoizes the producer's result) need the type.
 * Declaring it in either one makes the pair mutually dependent, and the
 * `no-circular-dependencies` gate counts a type-only edge like any other —
 * `madge` resolves imports before TypeScript erases them.
 */

export interface PageStylesheet {
  /** Workspace-relative POSIX path — the stable identity used for deterministic style-rule ids. */
  relPath: string
  /** Absolute path on disk, ready to read. */
  absPath: string
}
