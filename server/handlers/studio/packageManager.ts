/**
 * packageManager — which package manager a project uses, and the exact argv
 * Studio is allowed to ask it for.
 *
 * Split out of `installDeps.ts`, which owns the JOB (spawn, log cap, timeout,
 * persistence, routes). This half is pure: it reads lockfile presence and
 * builds argv arrays, touches no subprocess and no job state, and is therefore
 * the piece worth testing exhaustively on its own.
 *
 * Two rules live here and are not negotiable anywhere upstream:
 *
 *   - **`--ignore-scripts` is present in every argv this module can produce.**
 *     A postinstall script is arbitrary code execution and must not run before
 *     the user has consented to a trust tier that allows it. It is not a
 *     parameter, not conditional, and not reachable from the wire.
 *   - **Every caller-supplied value is validated before it becomes an argv
 *     token.** A package name goes through the same `isSafePackageName` gate
 *     the runtime resolver uses; a version goes through
 *     `isSafeDependencyVersion` so it cannot pose as a flag. There is no shell
 *     anywhere in this feature, but an argv array still lets a crafted value
 *     look like an option to the package manager.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isSafePackageName } from '@core/site-dependencies/packageNames'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

/** Checked in order; the first lockfile present wins. */
const LOCKFILE_MANAGERS: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
]

/** No lockfile present (or an unrecognized one) defaults to `bun` — this project's own toolchain. */
export function detectPackageManager(dir: string): PackageManager {
  for (const { file, manager } of LOCKFILE_MANAGERS) {
    if (existsSync(join(dir, file))) return manager
  }
  return 'bun'
}

/** `--ignore-scripts` is mandatory for every manager — never conditional, never wire-configurable. */
const INSTALL_ARGV: Record<PackageManager, string[]> = {
  bun: ['bun', 'install', '--ignore-scripts'],
  pnpm: ['pnpm', 'install', '--ignore-scripts'],
  yarn: ['yarn', 'install', '--ignore-scripts'],
  npm: ['npm', 'install', '--ignore-scripts'],
}

export interface AddDependencyMutation {
  kind: 'add'
  /** Already validated by `isSafeDependencyName` at the route boundary — see that function's doc. */
  name: string
  /** Already validated by `isSafeDependencyVersion`. `'*'` when the caller didn't specify one — resolves to each manager's own "latest" behaviour. */
  version: string
  dev: boolean
}
export interface RemoveDependencyMutation {
  kind: 'remove'
  name: string
}
export type DependencyMutation = AddDependencyMutation | RemoveDependencyMutation

/** Same package-name gate the client (`DepsSection.tsx`) and the runtime dependency resolver already use — re-validated here because a request body is never trusted just because the client already checked. */
export function isSafeDependencyName(name: string): boolean {
  return isSafePackageName(name)
}

/**
 * A version/range specifier is appended directly after `name@` in a single
 * argv token (`bun add foo@<version>`) — never shell-interpolated, but still
 * validated so it can't be crafted to look like a FLAG to the package
 * manager (e.g. a version starting with `-`) or carry characters no real
 * semver range/tag uses. `'*'`/`'latest'` (the common "no opinion" values)
 * and ordinary semver ranges (`^1.2.3`, `~1.2.3`, `1.x`, `>=1.0.0 <2.0.0` is
 * NOT supported — a single token only, which covers every version this UI
 * actually lets a user type) all pass.
 */
const SAFE_DEPENDENCY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.^~*_+-]*$/

export function isSafeDependencyVersion(version: string): boolean {
  return SAFE_DEPENDENCY_VERSION_RE.test(version)
}

/** `name@version` — `'*'`/`'latest'` degrade to a bare `name` so each manager resolves its own idea of "latest" rather than being told to literally install the tag `"*"`. */
function dependencySpec(name: string, version: string): string {
  return version === '*' || version === 'latest' ? name : `${name}@${version}`
}

function addArgv(manager: PackageManager, mutation: AddDependencyMutation): string[] {
  const spec = dependencySpec(mutation.name, mutation.version)
  switch (manager) {
    case 'bun':
      return ['bun', 'add', spec, ...(mutation.dev ? ['--dev'] : []), '--ignore-scripts']
    case 'pnpm':
      return ['pnpm', 'add', spec, ...(mutation.dev ? ['--save-dev'] : []), '--ignore-scripts']
    case 'yarn':
      return ['yarn', 'add', spec, ...(mutation.dev ? ['--dev'] : []), '--ignore-scripts']
    case 'npm':
      return ['npm', 'install', spec, mutation.dev ? '--save-dev' : '--save', '--ignore-scripts']
  }
}

function removeArgv(manager: PackageManager, mutation: RemoveDependencyMutation): string[] {
  // npm alone spells this "uninstall" — every other manager (and npm's own
  // alias) accepts "remove", but this stays explicit rather than relying on
  // an alias.
  const verb = manager === 'npm' ? 'uninstall' : 'remove'
  return [manager, verb, mutation.name, '--ignore-scripts']
}

/** The argv for a bare install, or for the one add/remove mutation the caller asked for. */
export function installArgv(manager: PackageManager, mutation: DependencyMutation | undefined): string[] {
  if (!mutation) return INSTALL_ARGV[manager]
  return mutation.kind === 'add' ? addArgv(manager, mutation) : removeArgv(manager, mutation)
}
