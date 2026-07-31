/**
 * appRoot — `dir -> absolute, containment-checked app root` (`approot-01`).
 *
 * A project's app root is not always its project directory: an imported repo
 * can land its real `package.json` one or two levels below the project
 * directory it was checked out into (a monorepo's `apps/web/`, an
 * `examples/` folder, or a named subdirectory like `journey-screens/`).
 * `projectProbe.ts`'s `detectAppRoot` is the DETECTOR (bounded search,
 * ranking, warnings) and lives on `ProjectProfile.appRoot` as a
 * project-relative POSIX path (`''` when the app root is the project
 * directory itself). This module is the one place every OTHER consumer that
 * needs the app root RESOLVED to a real, safe, absolute directory — to spawn
 * a package-manager install, to resolve `node_modules/<pkg>`, to find a
 * Sass/PostCSS binary — goes, instead of five separate `join(dir, appRoot)`
 * calls that can drift apart on containment posture.
 *
 * `resolveAppRoot(dir)` reads the CACHED profile when `.studio/meta.json` has
 * one, else probes fresh (read-only, matching `GET /probe`'s own
 * cached-or-fresh posture) — never persists anything itself. `appRoot` is
 * cached in a file the user can hand-edit, so the resolved candidate is
 * real-path containment-checked (`workspacePackageResolve.ts`'s
 * `isRealpathContained`, the same symlink-safe primitive `sec-01` already
 * uses everywhere else in this module family) before being trusted — an
 * escape attempt, or a stale cache pointing at a directory that no longer
 * exists, degrades to the project directory itself rather than throwing or
 * (worse) resolving outside the project.
 */
import { resolve } from 'node:path'
import { probeProject } from './projectProbe'
import { readStudioMeta } from './studioMeta'
import { isRealpathContained } from './workspacePackageResolve'

/**
 * Pure join-and-containment-check: `dir` + a project-relative `appRoot` path
 * (as already sits on `ProjectProfile.appRoot`) -> an absolute, real-path-
 * contained directory. Falls back to `dir` itself (unchanged behavior for the
 * common `appRoot === ''` case, and the safe degradation for every
 * adversarial one) whenever `appRoot` is empty, unresolvable, or escapes
 * `dir`. Exported separately from {@link resolveAppRoot} for callers that
 * already have a `ProjectProfile` in hand (`styleCompile.ts`,
 * `tokenExtract.ts`) and would otherwise trigger a redundant cache-read/probe
 * to re-derive the same value.
 */
export function joinAppRoot(dir: string, appRoot: string): string {
  const root = resolve(dir)
  if (!appRoot) return root

  const candidate = resolve(root, ...appRoot.split('/'))
  return isRealpathContained(candidate, root) ? candidate : root
}

/**
 * The project's app root, resolved to an absolute, real-path-contained
 * directory — reads the cached profile when `.studio/meta.json` has one,
 * else probes fresh (read-only, matching `GET /probe`'s own posture). For a
 * caller that already has a `ProjectProfile`, use {@link joinAppRoot} instead
 * to avoid a redundant read.
 */
export function resolveAppRoot(dir: string): string {
  const appRoot = readStudioMeta(dir).profile?.appRoot ?? probeProject(dir).appRoot
  return joinAppRoot(dir, appRoot)
}
