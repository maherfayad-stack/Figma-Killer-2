/**
 * designSystemDetect — where does this project's design system live on disk,
 * regardless of whether it is Studio's BUILT-IN one (source `'builtin'`, the
 * `<project>/design-system/` folder), arrived via `npm install` (source
 * `'node-modules'`), or came from the manual "Import design tokens" wizard's
 * CSS copy (source `'imported'`).
 *
 * Root cause this exists to fix: every mechanism Studio has for giving an
 * agent design-system knowledge — `almosafer-ds-expert`'s embedded
 * `CLAUDE.md`/`design.md`, `studio_read_package_doc`, the generated
 * `design-system.md` reference (`agentRoster.ts`) — is keyed on
 * `profile.componentPackages`, which itself is keyed on `node_modules`. A
 * project imported through the design-token wizard has no `package.json` at
 * all (the import wizard only ever writes CSS into
 * `styles/imported/<slug>/`, never a manifest), so `componentPackages` is
 * permanently empty and every one of those mechanisms falls back to "nothing
 * authoritative to consult" even though 260 KB of the project's own design
 * tokens and component stylesheets sit right there on disk.
 *
 * `detectDesignSystems` reports BOTH sources so a consumer doesn't need two
 * separate lookups: an installed `componentPackages` dependency (root inside
 * `node_modules/`, so it needs the app-root prefix every other install-
 * dependent path on `ProjectProfile` carries) and every immediate
 * subdirectory of `styles/imported/` (root always relative to the PROJECT
 * DIRECTORY itself, never the app root — `designImport.ts`'s `copy-css` route
 * writes there unconditionally, regardless of where a nested app's own
 * `package.json` happens to live).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_DESIGN_SYSTEM_DIR, isDesignSystemBacked } from './builtinDesignSystem'
import type { DesignSystemRef } from './projectProfileSchema'

const IMPORTED_DESIGN_SYSTEMS_DIR = 'styles/imported'

/**
 * Studio's BUILT-IN design system, as this project sees it.
 *
 * A DS-backed project carries a Studio-written `<project>/design-system/`
 * folder (`isDesignSystemBacked`) — that is the whole declaration; there is no
 * dependency to look up, because there is no npm package any more. Its
 * components resolve to `alm.<Name>` (`moduleMapping.ts`) and render from
 * Studio's OWN vendored source, so this ref exists to tell an agent (and the
 * digest/guide generators) that the system is there and where the project's
 * copy of its source sits.
 *
 * `root` names the PROJECT's copy — the folder a user's imports point at. The
 * design system's DOCS and its compiled `dist/index.css` are read from Studio's
 * own `BUILTIN_DESIGN_SYSTEM_DIR` instead, because the project's copy carries
 * source only; `designSystemCssRoot` (`designSystemDigest.ts`) is the one place
 * that mapping is written down.
 */
const BUILTIN_DESIGN_SYSTEM_NAME = 'alm'

/**
 * Every immediate subdirectory of `<root>/styles/imported/` — one per
 * "Import design tokens" wizard run, since `designImport.ts`'s `copy-css`
 * route always lands its files at `styles/imported/<slug>/`. Never throws: an
 * absent directory (the common case — most projects never ran that wizard)
 * just yields no entries.
 */
function listImportedDesignSystemSlugs(root: string): string[] {
  try {
    return readdirSync(join(root, ...IMPORTED_DESIGN_SYSTEMS_DIR.split('/')), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * `root` is the PROJECT directory (the same `dir` `probeProject` was called
 * with) — NOT the app root, since `styles/imported/` is never inside one.
 * `componentPackages` is the list `detectComponentPackages` already computed
 * (every dependency whose entry ships React components); `prefixAppRoot`
 * is `probeProject`'s own closure for turning an app-root-relative path into
 * a project-relative one, reused here so `node-modules` entries carry the
 * same path convention every other install-dependent field on this profile
 * does.
 */
export function detectDesignSystems(
  root: string,
  componentPackages: readonly string[],
  prefixAppRoot: (relPath: string) => string,
): DesignSystemRef[] {
  const fromNodeModules: DesignSystemRef[] = componentPackages.map((name) => ({
    name,
    source: 'node-modules',
    root: prefixAppRoot(['node_modules', ...name.split('/')].join('/')),
  }))

  const fromImported: DesignSystemRef[] = listImportedDesignSystemSlugs(root).map((slug) => ({
    name: slug,
    source: 'imported',
    root: `${IMPORTED_DESIGN_SYSTEMS_DIR}/${slug}`,
  }))

  const builtin: DesignSystemRef[] = isDesignSystemBacked(root)
    ? [{ name: BUILTIN_DESIGN_SYSTEM_NAME, source: 'builtin', root: PROJECT_DESIGN_SYSTEM_DIR }]
    : []

  // Built-in FIRST: it is the system this project's pages actually import, and
  // every consumer that picks "the" design system (the guide generator, the
  // catalog's empty-state note) should land on it before an installed package
  // or a CSS-only wizard copy.
  return [...builtin, ...fromNodeModules, ...fromImported]
}
