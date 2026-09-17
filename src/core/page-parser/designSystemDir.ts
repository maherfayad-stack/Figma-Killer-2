/**
 * designSystemDir — the one folder in a user's project that Studio WROTE and
 * Studio OWNS: `<project>/design-system/`.
 *
 * A DS-backed project carries a copy of Studio's built-in design system
 * (`vendor/alm-design-system/src/`, written by `designSystemFiles.ts`) so the
 * repository builds and downloads standalone, and its pages import it
 * relatively: `import { Button } from '../design-system'`. Studio itself never
 * renders from that copy — the canvas renders the `alm.*` module pack out of
 * its OWN vendored source — so for every part of the parse pipeline the folder
 * is a **black box**:
 *
 *   - `componentSources.ts` classifies an import landing in it as
 *     `{ kind: 'design-system', name }`, NOT `local`, so
 *     `inlineLocalComponents` leaves the call site opaque (it skips every
 *     non-`local` source already) and the node keeps its call-site props.
 *     Expanding it would replace one `<Button variant="primary"/>` the user
 *     can edit with forty nodes of a component they do not own.
 *   - its stylesheets never enter the editable `StyleRule` registry
 *     (`collectPageStylesheets`, `styleCompile`) — the canvas already injects
 *     Studio's own copy of that CSS as a read-only `@layer vendor` bucket, so
 *     collecting it again would bury the user's own classes under ~400 rules
 *     they cannot meaningfully edit.
 *   - it is never searched for PAGES (`discoverPageFiles`, the probe's
 *     pages-dir heuristic) and never listed as the project's own components or
 *     assets. Forty `.jsx` files that each default-export JSX otherwise look
 *     exactly like a pages directory.
 *
 * This is the same contract — and the same class of failure when it is missing
 * — as {@link isPrototypeShellPath} in `./workspaceFiles`: Studio's own files,
 * sitting inside the user's repository, must never be read back as the thing
 * being designed.
 *
 * ## Two constants, deliberately
 *
 * `PROJECT_DESIGN_SYSTEM_DIR` here is the BROWSER-side/core copy;
 * `server/handlers/studio/builtinDesignSystem.ts` declares the identical
 * literal for the server half (which also owns where Studio's vendored source
 * lives — a path this module must never know). The browser core cannot import
 * `server/`, so the constant is mirrored rather than shared, exactly as
 * `fsCodemodAdapter.ts` mirrors `INLINE_ID_SEPARATOR`. They are held equal by
 * `src/core/page-parser/__tests__/designSystemDir.test.ts`; nothing else
 * enforces it.
 */

/** The folder, relative to a project root, holding Studio's copy of the built-in design system. */
export const PROJECT_DESIGN_SYSTEM_DIR = 'design-system'

/**
 * True when a workspace-relative POSIX path is inside the Studio-written
 * design-system folder rather than the user's own source.
 *
 * Root-anchored on purpose: a user's own `src/design-system/` folder of
 * hand-written components is theirs, is local, and stays fully inlinable and
 * editable. Only the folder at the project ROOT is Studio's.
 */
export function isDesignSystemPath(relPath: string): boolean {
  return relPath === PROJECT_DESIGN_SYSTEM_DIR || relPath.startsWith(`${PROJECT_DESIGN_SYSTEM_DIR}/`)
}

/**
 * How `<project>/design-system` is spelled as an import specifier FROM a given
 * workspace-relative file — `pages/Home.tsx` -> `'../design-system'`,
 * `pages/account/Settings.tsx` -> `'../../design-system'`, a file at the
 * project root -> `'./design-system'`.
 *
 * The SERVER computes this, never the client: only the server knows where in
 * the tree the file being written actually sits, and a specifier guessed from
 * the browser would be a path that resolves to nothing (or, worse, to a
 * different folder). See `studioStructuralWriteback.ts`'s `designSystemImport`.
 *
 * The ONE implementation of that rule. `designSystemFiles.ts` used to carry a
 * second one taking two absolute directories; it agreed on every case, which
 * is exactly why it was a liability — two spellings of one rule that a future
 * change only has to touch one of. Server callers hand this the workspace-
 * relative path of the file being written (`pageScaffold.ts`, `projectRoutes.ts`,
 * `designSystemMigrate.ts`, `studioStructuralWriteback.ts`).
 */
export function designSystemImportSpecifier(fromFileRel: string): string {
  const fromDir = fromFileRel.split('/').filter((segment) => segment.length > 0).slice(0, -1)
  const ups = fromDir.length
  return ups === 0 ? `./${PROJECT_DESIGN_SYSTEM_DIR}` : `${'../'.repeat(ups)}${PROJECT_DESIGN_SYSTEM_DIR}`
}
