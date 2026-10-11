/**
 * tokenThemeRename - the part of a rename that exists only for a Tailwind v4
 * `@theme` variable (CT-6): its name is also the utility classes that read it,
 * so the rename moves `--color-brand` AND `bg-brand`, `text-brand`,
 * `hover:border-brand/50`... in one plan (`tokenThemeClasses.ts` finds them,
 * `@core/studio-tokens` `themeUtilities.ts` is the vocabulary).
 *
 * Everything that makes that unsafe is a refusal here, named, with the
 * one-click way forward in its sentence:
 *
 *   - a namespace whose name is read by far more than a rename can follow
 *     (`--spacing-*`, `--breakpoint-*`, `--container-*`, the bare `--spacing`);
 *   - a new name that leaves the namespace (`--color-brand` -> `--brand`):
 *     the prefix is what makes it a `bg-` colour at all;
 *   - a name two namespaces both spell as one class (`text-lg` is a colour AND
 *     a size when both `--color-lg` and `--text-lg` exist): which one the
 *     class means is not a question a rename should answer;
 *   - a new name whose classes are already in use, or already declared;
 *   - a class used in a file type the undo journal cannot restore.
 *
 * A class built at runtime (`` `bg-${tone}` ``) cannot be followed; it is not a
 * refusal (it would refuse nearly every colour rename in a real app) but it is
 * not silent either: the plan returns its lines and the panel says so beside
 * the Undo.
 */
import { themeVariableOf, themeRenameBlockedReason, sharedUtilityNamespaces, type ThemeNamespace } from '@core/studio-tokens'
import { isWritableSourceRel } from '../studioEditRouting'
import { scanThemeClasses, type ThemeClassScan } from './tokenThemeClasses'
import { tokenRefusal, type TokenWriteRefusal } from './tokenWriteTypes'
import type { TokenWorkspaceFile } from './tokenWorkspaceFiles'

const MAX_SITES_LISTED = 5

export interface ThemeRenamePlan {
  /** Every variable that moves: the token itself, and the `--text-xs--line-height`-style companions Tailwind pairs with it by name. */
  readonly names: ReadonlyMap<string, string>
  /** The file's text with the theme's utility classes moved, and the lines where a class is built at runtime. */
  readonly rewriteClasses: (file: string, text: string) => ThemeClassScan
}

function sitesOf(sites: readonly string[]): string {
  const shown = sites.slice(0, MAX_SITES_LISTED).join(', ')
  return sites.length > MAX_SITES_LISTED ? `${shown} and ${sites.length - MAX_SITES_LISTED} more` : shown
}

function blocked(message: string, remedy: string): TokenWriteRefusal {
  return tokenRefusal(0, 'rename-blocked', message, { remedy })
}

const CREATE_MOVE_REMOVE = 'Create the new name with the same value, move the usages over, then remove the old one.'

/**
 * The plan for renaming the `@theme` variable `name` to `to`, or the refusal.
 * `declared` is every custom property the canvas's stylesheets declare;
 * `workspace` the project's text files (all of them, not only those with `--`).
 */
export function planThemeRename(name: string, to: string, declared: ReadonlySet<string>, workspace: readonly TokenWorkspaceFile[]): ThemeRenamePlan | TokenWriteRefusal {
  const blockedReason = themeRenameBlockedReason(name)
  if (blockedReason) {
    return blocked(`${name} is a Tailwind theme variable, and ${blockedReason}.`, `${CREATE_MOVE_REMOVE} Or edit its value in place - that is always safe.`)
  }
  const variable = themeVariableOf(name)
  if (!variable) return blocked(`${name} is not in a Tailwind theme namespace.`, CREATE_MOVE_REMOVE)
  const { namespace, key } = variable
  if (key.includes('--')) {
    const owner = name.slice(0, name.indexOf('--', namespace.prefix.length))
    return blocked(`${name} belongs to ${owner} (Tailwind pairs them by name), so it cannot be renamed on its own.`, `Rename ${owner} instead; ${name} moves with it.`)
  }
  const target = themeVariableOf(to)
  if (!target || target.namespace !== namespace) {
    return blocked(`${name} is a Tailwind ${namespace.prefix}* variable, and the ${namespace.prefix} prefix is what makes ${key} a class name (for example ${namespace.apply[0]}-${key}). ${to} would stop being one.`, `Keep the ${namespace.prefix} prefix: ${namespace.prefix}${key} -> ${namespace.prefix}<new name>.`)
  }
  if (target.key.includes('--')) return blocked(`${to} would read as a companion of another variable.`, `Pick a name without a double dash after ${namespace.prefix}.`)

  const names = new Map<string, string>([[name, to]])
  for (const other of declared) {
    if (other.startsWith(`${name}--`)) names.set(other, `${to}${other.slice(name.length)}`)
  }
  for (const next of names.values()) {
    if (declared.has(next)) return tokenRefusal(0, 'already-declared', `${next} is already declared, so renaming ${name} to ${to} would merge two tokens.`, { remedy: 'Pick a name nothing uses.' })
  }

  const ambiguous = ambiguousUtility(namespace, [key, target.key], declared)
  if (ambiguous) {
    return blocked(`${ambiguous.utility}-${ambiguous.key} would mean two things: ${namespace.prefix}${ambiguous.key} and ${ambiguous.other.prefix}${ambiguous.key} are both theme variables behind the same utility.`, 'Rename or remove one of the two first, so each class has a single meaning.')
  }

  const takenSites: string[] = []
  const strandedFiles: string[] = []
  for (const file of workspace) {
    if (scanThemeClasses(file.file, file.text, namespace, target.key, null).count > 0) takenSites.push(file.file)
    const uses = scanThemeClasses(file.file, file.text, namespace, key, null).count
    if (uses > 0 && !isWritableSourceRel(file.file, { journalStylesheets: 'allow' })) strandedFiles.push(file.file)
  }
  if (takenSites.length > 0) {
    return tokenRefusal(0, 'invalid-input', `${namespace.apply[0]}-${target.key} is already used as a class in ${sitesOf([...new Set(takenSites)])}, so renaming ${name} to ${to} would silently change what those classes mean.`, { remedy: 'Pick a name nothing uses.' })
  }
  if (strandedFiles.length > 0) {
    return tokenRefusal(0, 'read-only-source', `Classes that use ${name} (for example ${namespace.apply[0]}-${key}) are written in ${sitesOf(strandedFiles)}, a file type Studio cannot rewrite with an undo.`, {
      remedy: 'Change those classes with the file tools first (or in your editor), then try again.',
      declarations: strandedFiles,
    })
  }

  return {
    names,
    rewriteClasses: (file, text) => scanThemeClasses(file, text, namespace, key, target.key),
  }
}

/** A utility two namespaces both own whose class, for `keys`, would be spelled by a declared variable of the other namespace too. */
function ambiguousUtility(namespace: ThemeNamespace, keys: readonly string[], declared: ReadonlySet<string>): { utility: string; key: string; other: ThemeNamespace } | null {
  for (const utility of namespace.utilities) {
    for (const other of sharedUtilityNamespaces(namespace, utility)) {
      for (const key of keys) {
        if (declared.has(`${other.prefix}${key}`)) return { utility, key, other }
      }
    }
  }
  return null
}

export interface ThemeClassReaders {
  /** One entry per class that reads the variable, as `file`. */
  readonly readers: readonly string[]
  /** Moves those classes to the replacement variable's; `null` when there are no readers or no replacement. */
  readonly rewriteClasses: ((file: string, text: string) => ThemeClassScan) | null
}

/**
 * The utility classes that read the `@theme` variable `name`, for removing it:
 * a variable still spelled as a class is still used. With a replacement in the
 * same namespace they move to it; in another namespace they cannot (a colour
 * class has no size to become), so that is a refusal. A namespace whose
 * readers cannot be found by their spelling (`--spacing-*`, `--breakpoint-*`)
 * cannot be removed honestly at all.
 */
export function planThemeClassReaders(name: string, replaceWith: string | undefined, workspace: readonly TokenWorkspaceFile[]): ThemeClassReaders | TokenWriteRefusal {
  const variable = themeVariableOf(name)
  if (!variable) return { readers: [], rewriteClasses: null }
  const { namespace, key } = variable
  if (namespace.utilities.length === 0) {
    return tokenRefusal(0, 'remove-blocked', `${name} is a Tailwind theme variable, and ${namespace.renameBlocked}, so Studio cannot tell whether it is still used.`, {
      remedy: 'Search the project for the classes that use it, change them, then remove the declaration with the file tools.',
    })
  }
  const readers: string[] = []
  const stranded: string[] = []
  for (const file of workspace) {
    const uses = scanThemeClasses(file.file, file.text, namespace, key, null).count
    if (uses === 0) continue
    for (let i = 0; i < uses; i++) readers.push(file.file)
    if (!isWritableSourceRel(file.file, { journalStylesheets: 'allow' })) stranded.push(file.file)
  }
  if (readers.length === 0 || replaceWith === undefined) return { readers, rewriteClasses: null }
  if (stranded.length > 0) {
    return tokenRefusal(0, 'read-only-source', `Classes that use ${name} (for example ${namespace.apply[0]}-${key}) are written in ${sitesOf(stranded)}, a file type Studio cannot rewrite with an undo.`, {
      remedy: 'Change those classes with the file tools first, then try again.',
      declarations: stranded,
    })
  }
  const target = themeVariableOf(replaceWith)
  if (!target || target.namespace !== namespace) {
    return tokenRefusal(0, 'invalid-input', `${name} is used as a class (for example ${namespace.apply[0]}-${key}), and ${replaceWith} is not a ${namespace.prefix}* variable, so those classes have nothing to become.`, {
      remedy: `Pick a ${namespace.prefix}* variable to replace it with.`,
    })
  }
  return { readers, rewriteClasses: (file, text) => scanThemeClasses(file, text, namespace, key, target.key) }
}
