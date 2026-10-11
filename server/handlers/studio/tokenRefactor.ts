/**
 * tokenRefactor - PLAN a rename or a removal of a design token (CT-3): the
 * edits that touch many files at once, as opposed to `tokenWrite.ts`'s value
 * edits, which touch one declaration. Pure over the stylesheets the canvas
 * loads and the project's text files (`tokenWorkspaceFiles.ts`); the caller
 * commits the plan under the project write lock, exactly as for a value edit.
 *
 * ## Rename (CT-OD-4)
 *
 * Every mention of the old name in project source moves to the new one - the
 * declarations in every mode, `var(--x)` in CSS, strings and template literals
 * in TSX, Tailwind arbitrary values (`bg-[--x]`) - in one plan, so one undo
 * puts them all back. It refuses, naming why, when:
 *   - a declaration of the token is a package's / compiled output's / Studio's
 *     (there is no project file to rename it in);
 *   - the new name is already declared, or already named in source (renaming
 *     would silently merge two things);
 *   - the token lives in Tailwind's `@theme` under a utility namespace
 *     (`--color-*`, `--spacing-*`...), where the NAME is also the utility
 *     class (`bg-brand`), which no mention-level rename can follow.
 *
 * ## Remove
 *
 * All declarations go, plus the rules left empty. A token still read somewhere
 * is refused (`in-use`, with where) unless the request says which declared
 * token its readers move to (`replaceWith`) - the same mention rewrite as a
 * rename, applied to the readers only. A replacement that would end up
 * referring back to the removed token (a cycle) is refused.
 */
import { removeCustomPropertyDeclarations } from '@core/css-codemods'
import { findTokenMentions, lineOfOffset, rewriteTokenMentions, scanGatedDeclarations, type TokenEdit } from '@core/studio-tokens'
import { isWritableSourceRel } from '../studioEditRouting'
import type { TokenCssSource } from './projectTokenIndex'
import { tokenRefusal, type PlannedTokenFile, type TokenWritePlan, type TokenWriteRefusal } from './tokenWriteTypes'
import type { TokenWorkspaceFile } from './tokenWorkspaceFiles'

export type TokenRefactorEdit = Extract<TokenEdit, { op: 'rename' | 'remove' }>

/** Tailwind v4 namespaces whose `@theme` names are also utility classes. */
const TAILWIND_THEME_NAMESPACE_RE = /^--(?:color|font|text|spacing|radius|shadow|breakpoint|ease|animate|tracking|leading|blur|aspect|container)-/
const VAR_REFERENCE_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g
const MAX_SITES_LISTED = 5

interface FoundDeclaration {
  readonly source: TokenCssSource
  readonly name: string
  readonly raw: string
  readonly inTheme: boolean
  readonly line: number
}

function scanDeclarations(sources: readonly TokenCssSource[]): FoundDeclaration[] {
  const found: FoundDeclaration[] = []
  for (const source of sources) {
    if (!source.css) continue
    for (const declaration of scanGatedDeclarations(source.css)) {
      found.push({ source, name: declaration.name, raw: declaration.raw, inTheme: declaration.inTheme, line: lineOfOffset(source.css, declaration.offset) })
    }
  }
  return found
}

function whereOf(entry: FoundDeclaration): string {
  return `${entry.source.file}:${entry.line}`
}

/** Whether following `var()` references out of `from` reaches `target`. */
function reaches(declarations: readonly FoundDeclaration[], from: string, target: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const decl of declarations) {
      if (decl.name !== current) continue
      for (const match of decl.raw.matchAll(VAR_REFERENCE_RE)) stack.push(match[1]!)
    }
  }
  return false
}

function siteList(sites: readonly string[]): string {
  const shown = sites.slice(0, MAX_SITES_LISTED).join(', ')
  return sites.length > MAX_SITES_LISTED ? `${shown} and ${sites.length - MAX_SITES_LISTED} more` : shown
}

/** The files `next` changed, as plan entries. */
function changedFiles(workspace: readonly TokenWorkspaceFile[], next: ReadonlyMap<string, string>): PlannedTokenFile[] {
  const files: PlannedTokenFile[] = []
  for (const file of workspace) {
    const text = next.get(file.file)
    if (text !== undefined && text !== file.text) files.push({ file: file.file, original: file.text, next: text })
  }
  return files
}

/** Why the declarations of `name` cannot be edited in place, or `null` when every one is a readable project file. */
function declarationRefusal(name: string, declarations: readonly FoundDeclaration[], workspace: readonly TokenWorkspaceFile[], verb: string): TokenWriteRefusal | null {
  const readOnly = declarations.filter((decl) => decl.source.origin !== 'project')
  if (readOnly.length > 0) {
    return tokenRefusal(0, 'read-only-source', `${name} is declared in ${siteList(readOnly.map((decl) => decl.source.file))}, which is not a project file Studio edits in place, so it cannot be ${verb}.`, {
      remedy: `Override it in the project's own stylesheet instead (declare ${name} there), or edit the package's source.`,
    })
  }
  const unreadable = declarations.find((decl) => !workspace.some((file) => file.file === decl.source.file))
  if (unreadable) {
    return tokenRefusal(0, 'read-only-source', `${name} is declared in ${unreadable.source.file}, which Studio could not read as a text file, so it cannot be ${verb}.`, {
      remedy: 'Edit that file with the file tools.',
    })
  }
  return null
}

/**
 * Files that mention `name` but that the undo journal cannot name (`.scss`,
 * `.html`, `.vue`...). A rewrite of one would land with no undo, so the plan
 * refuses up front rather than writing something ⌘Z cannot take back.
 */
function unjournalableMentions(name: string, workspace: readonly TokenWorkspaceFile[]): string[] {
  return workspace
    .filter((file) => !isWritableSourceRel(file.file, { journalStylesheets: 'allow' }) && findTokenMentions(file.text).some((mention) => mention.name === name))
    .map((file) => file.file)
}

export function planTokenRefactor(
  sources: readonly TokenCssSource[],
  workspace: readonly TokenWorkspaceFile[],
  edit: TokenRefactorEdit,
): TokenWritePlan | TokenWriteRefusal {
  const declarations = scanDeclarations(sources)
  const own = declarations.filter((decl) => decl.name === edit.name)
  if (own.length === 0) {
    return tokenRefusal(0, 'no-such-token', `${edit.name} is not declared in any stylesheet the canvas loads.`, {
      remedy: 'Check the name in the Variables panel (or studio_list_tokens).',
    })
  }
  const stranded = unjournalableMentions(edit.name, workspace)
  if (stranded.length > 0) {
    return tokenRefusal(0, 'read-only-source', `${edit.name} is also named in ${siteList(stranded)}, a file type Studio cannot rewrite with an undo.`, {
      remedy: 'Change those mentions with the file tools first (or in your editor), then try again.',
      declarations: stranded,
    })
  }
  return edit.op === 'rename' ? planRename(edit, own, declarations, workspace) : planRemove(edit, own, declarations, workspace)
}

function planRename(
  edit: Extract<TokenRefactorEdit, { op: 'rename' }>,
  own: readonly FoundDeclaration[],
  declarations: readonly FoundDeclaration[],
  workspace: readonly TokenWorkspaceFile[],
): TokenWritePlan | TokenWriteRefusal {
  const { name, to } = edit
  if (to === name) return tokenRefusal(0, 'invalid-input', `${name} already has that name.`)
  const refused = declarationRefusal(name, own, workspace, 'renamed')
  if (refused) return refused

  const taken = declarations.filter((decl) => decl.name === to)
  if (taken.length > 0) {
    return tokenRefusal(0, 'already-declared', `${to} is already declared at ${siteList(taken.map(whereOf))}, so renaming ${name} to it would merge two tokens.`, {
      remedy: 'Pick a name nothing uses, or remove one of them first (Remove, replacing its readers).',
      declarations: taken.map(whereOf),
    })
  }
  const themed = own.find((decl) => decl.inTheme && TAILWIND_THEME_NAMESPACE_RE.test(name))
  if (themed) {
    return tokenRefusal(0, 'rename-blocked', `${name} is a Tailwind theme variable, so its name is also the utility class (for example bg-${name.slice(8)}); renaming it would leave every class using it pointing at nothing.`, {
      remedy: 'Create the new name with the same value, move the usages over, then remove the old one.',
    })
  }
  const named = workspace.flatMap((file) => findTokenMentions(file.text).filter((mention) => mention.name === to).map(() => file.file))
  if (named.length > 0) {
    return tokenRefusal(0, 'invalid-input', `${to} is already named ${named.length} time${named.length === 1 ? '' : 's'} in the project's source (${siteList([...new Set(named)])}), so renaming ${name} to it would silently change what those mean.`, {
      remedy: 'Pick a name nothing uses.',
    })
  }

  const next = new Map<string, string>()
  let mentions = 0
  for (const file of workspace) {
    const rewritten = rewriteTokenMentions(file.text, (mention) => (mention.name === name ? to : null))
    if (rewritten.count === 0) continue
    mentions += rewritten.count
    next.set(file.file, rewritten.text)
  }
  const files = changedFiles(workspace, next)
  return { ok: true, files, changed: [], unchanged: [], inserted: [], renamed: [{ name, to, mentions, files: files.length }], removed: [] }
}

function planRemove(
  edit: Extract<TokenRefactorEdit, { op: 'remove' }>,
  own: readonly FoundDeclaration[],
  declarations: readonly FoundDeclaration[],
  workspace: readonly TokenWorkspaceFile[],
): TokenWritePlan | TokenWriteRefusal {
  const { name, replaceWith } = edit
  const refused = declarationRefusal(name, own, workspace, 'removed')
  if (refused) return refused

  const readers: string[] = []
  for (const file of workspace) {
    file.text.split(/\r?\n/).forEach((line, index) => {
      for (const mention of findTokenMentions(line)) {
        if (mention.name === name && !mention.declaration) readers.push(`${file.file}:${index + 1}`)
      }
    })
  }
  if (readers.length > 0 && replaceWith === undefined) {
    return tokenRefusal(0, 'in-use', `${name} is still used ${readers.length} time${readers.length === 1 ? '' : 's'} (${siteList(readers)}), so removing it would leave those with no value.`, {
      remedy: 'Choose another variable to replace it with, or change those places first.',
      declarations: readers,
    })
  }
  if (replaceWith !== undefined) {
    if (replaceWith === name) return tokenRefusal(0, 'invalid-input', `${name} cannot replace itself.`)
    if (!declarations.some((decl) => decl.name === replaceWith)) {
      return tokenRefusal(0, 'no-such-token', `${replaceWith} is not declared in any stylesheet the canvas loads, so ${name} cannot be replaced with it.`, {
        remedy: 'Pick a variable from the list.',
      })
    }
    if (readers.length > 0 && reaches(declarations, replaceWith, name)) {
      return tokenRefusal(0, 'invalid-input', `${replaceWith} is itself defined in terms of ${name}, so replacing ${name} with it would make it refer to itself.`, {
        remedy: 'Pick a variable that does not depend on this one.',
      })
    }
  }

  const declaringFiles = new Set(own.map((decl) => decl.source.file))
  const next = new Map<string, string>()
  let moved = 0
  for (const file of workspace) {
    let text = file.text
    if (replaceWith !== undefined) {
      const rewritten = rewriteTokenMentions(text, (mention) => (mention.name === name && !mention.declaration ? replaceWith : null))
      moved += rewritten.count
      text = rewritten.text
    }
    if (declaringFiles.has(file.file)) {
      const removal = removeCustomPropertyDeclarations(text, name)
      if (!removal.ok) return tokenRefusal(0, 'invalid-input', removal.message, { remedy: 'Fix the stylesheet, or remove the declaration with the file tools.' })
      if (removal.removed === 0) {
        return tokenRefusal(0, 'stale-source', `${name} is no longer declared in ${file.file}; the file changed since it was read.`, { remedy: 'Try again; the file is re-read.' })
      }
      text = removal.css
    }
    if (text !== file.text) next.set(file.file, text)
  }
  const files = changedFiles(workspace, next)
  return {
    ok: true,
    files,
    changed: [],
    unchanged: [],
    inserted: [],
    renamed: [],
    removed: [{ name, declarations: own.length, movedReaders: moved, ...(replaceWith !== undefined ? { replacedWith: replaceWith } : {}) }],
  }
}
