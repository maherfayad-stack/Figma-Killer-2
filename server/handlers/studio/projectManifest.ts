/**
 * projectManifest - what the OPEN PROJECT's own `package.json` declares, and
 * which of it is actually on disk.
 *
 * The Dependencies panel used to list the CMS site's package mirror, so a
 * project with four declared packages read "No dependencies yet." This is the
 * project's truth: `dependencies` + `devDependencies` from the app root's
 * `package.json`, and the declared names that have a `node_modules/<name>`
 * install. Read-only, bounded, and path-free (the client gets names and version
 * ranges, never a filesystem location).
 *
 * The names come out of a file the user did not necessarily write (a repository
 * arrives from GitHub), so a name is only joined onto a path after it passes the
 * same package-name rule the panel's Add form uses: no separators other than the
 * scope's one `/`, no leading dot, so no `..` can climb out of `node_modules`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import { resolveAppRoot } from './appRoot'

/** A manifest with more than this many entries in one section is truncated: the panel is a list, not an audit. */
export const MAX_MANIFEST_ENTRIES = 1000

export interface ProjectManifest {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  /** Declared names (either section) with a package installed under `node_modules`. */
  installedPackages: string[]
}

function readSection(parsed: Record<string, unknown>, key: 'dependencies' | 'devDependencies'): Record<string, string> {
  const section = parsed[key]
  const out: Record<string, string> = {}
  if (!section || typeof section !== 'object' || Array.isArray(section)) return out
  for (const [name, range] of Object.entries(section as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_MANIFEST_ENTRIES) break
    if (typeof range === 'string') out[name] = range
  }
  return out
}

/** Never throws: a missing or malformed `package.json` is an empty manifest. */
export function readProjectManifest(dir: string): ProjectManifest {
  const root = resolveAppRoot(dir)
  const pkgPath = join(root, 'package.json')
  let parsed: Record<string, unknown> = {}
  try {
    if (existsSync(pkgPath)) {
      const raw: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
    }
  } catch (err) {
    console.error('[projectManifest] package.json is not readable JSON:', err instanceof Error ? err.message : err)
  }
  const dependencies = readSection(parsed, 'dependencies')
  const devDependencies = readSection(parsed, 'devDependencies')
  const installedPackages = [...new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)])].filter(
    (name) => isSafePackageName(name) && existsSync(join(root, 'node_modules', name, 'package.json')),
  )
  return { dependencies, devDependencies, installedPackages }
}
