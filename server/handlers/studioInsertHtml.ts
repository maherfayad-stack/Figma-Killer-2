/**
 * studioInsertHtml - the write behind pasting HTML onto a board backed by real
 * files (G-10): the converted elements go into the page's JSX, the CSS that came
 * with them goes into the page's stylesheet, and either both land or neither.
 *
 * `HTML_IMPORT_ON_SOURCE_REFUSAL` used to refuse this outright - a block of HTML
 * "has no single honest form". It has one, as long as each of its two halves
 * has exactly one honest target:
 *
 *  - the markup: an `insert` of intrinsic elements into the container the user
 *    pointed at (`insertJsxElement`, the same codemod every other insert uses);
 *  - the styles: the ONE stylesheet the page itself already imports
 *    (`findPageStylesheet`), or - when it imports none - the elements' own
 *    `style` props. Not "a stylesheet somewhere in the project": a class in a
 *    file the page never loads would paint nothing.
 *
 * Both are decided and checked BEFORE a byte is written (the guard, the plan,
 * the stylesheet's own path check). The two writes then run in order, and the
 * batch's undo journal records the pre-image of both files, so ⌘Z is one step
 * and byte-exact (`isJournaled`: a pasted insert always asks for it). If the
 * second write fails the first is put back here, so a failure never leaves
 * markup whose classes point nowhere.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createProject, insertJsxElement, loadSourceFile } from '@core/ast-codemods'
import { classifyStylesheetEditability } from '@core/css-codemods'
import { listWorkspaceFiles, writeSourceFile } from '@core/page-parser'
import { MAX_PASTED_CSS_CHARS } from '@core/utils/pastedHtmlLimits'
import { insertPastedRules } from './studioCssWriteback'
import { resolveContainedRefPath } from './studioEditTargets'
import { guardPastedNodes, type PastedNode } from './studioPastedHtmlGuard'
import { planPastedStyles, type PastedHtmlSummary, type PlannedNode, type StyleDestination } from './studioPastedHtmlStyles'
import type { CreatedJsxLocation } from '@core/ast-codemods'

/** What the wire carries for a pasted insert (`InsertEditSchema`'s `pastedHtml` plus the node itself). */
export interface PastedHtmlInsert {
  name: string
  props?: Record<string, unknown>
  children?: string | readonly PastedNode[]
  importSpecifier?: string
  designSystemImport?: true
  siblings?: readonly PastedNode[]
  pastedHtml: { css?: string }
}

/**
 * The stylesheet a page's own imports give it, or `null`. Candidates are the
 * relative `.css` files the page imports that Studio may edit - a plain sheet
 * (class names are global), or a CSS Module the page imports WITH a default
 * binding (a side-effect-only import of a module reaches nothing). Several:
 * the one co-located with the page (`Home.tsx` + `Home.module.css`), else one in
 * the page's folder, else a module (scoped to this page by construction) before
 * a global sheet, else the first import.
 */
export function findPageStylesheet(dir: string, targetRel: string): StyleDestination | null {
  let imports: { specifier: string; binding: string | undefined }[]
  try {
    const sourceFile = loadSourceFile(createProject(), join(dir, targetRel))
    imports = sourceFile.getImportDeclarations().map((declaration) => ({
      specifier: declaration.getModuleSpecifierValue(),
      binding: declaration.getDefaultImport()?.getText(),
    }))
  } catch (err) {
    console.error('[studio] pasted html: could not read the page imports:', err)
    return null
  }

  const pageDir = posix.dirname(targetRel)
  const pageStem = posix.basename(targetRel).split('.')[0]
  const candidates: { destination: StyleDestination; rank: number }[] = []
  for (const { specifier, binding } of imports) {
    if (!specifier.startsWith('.') || !/\.css$/i.test(specifier)) continue
    const file = resolveContainedRefPath(dir, posix.normalize(posix.join(pageDir, specifier)))
    if (file === null || classifyStylesheetEditability(file).kind !== 'plain-css') continue
    const isModule = /\.module\.css$/i.test(file)
    if (isModule && !binding) continue
    const sameFolder = posix.dirname(file) === pageDir
    const coLocated = sameFolder && posix.basename(file).split('.')[0] === pageStem
    candidates.push({
      destination: isModule ? { kind: 'module', file, binding: binding! } : { kind: 'global', file },
      rank: (coLocated ? 0 : sameFolder ? 10 : 20) + (isModule ? 0 : 5) + candidates.length / 1000,
    })
  }
  candidates.sort((a, b) => a.rank - b.rank)
  return candidates[0]?.destination ?? null
}

/** The absolute stylesheet a pasted insert into `targetRel` may write, for the batch's touched-file set. */
export function pastedHtmlStylesheet(dir: string, targetRel: string): string | null {
  const destination = findPageStylesheet(dir, targetRel)
  return destination ? join(dir, ...destination.file.split('/')) : null
}

const MAX_SCANNED_FILES = 3000
const MAX_SCANNED_BYTES = 1024 * 1024
const CLASS_IN_CSS = /\.(-?[_a-zA-Z][\w-]*)/g
/**
 * Every quoted string in a source file. A class reaches an element through
 * `className="a b"`, `clsx('a', { b: on })`, `cn(...)`, `` `${x} a` ``, a lookup
 * table - the only thing they share is that the name is written in a string.
 * Over-approximate on purpose: a pasted class that merely LOOKS used is renamed.
 */
const QUOTED_STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g

/**
 * Class names a pasted class must not share: every class a project stylesheet
 * defines and every token a source file puts in a `class`/`className`. A
 * CSS Module's names are local to its file, so for a module destination only
 * that file's own names count.
 */
function takenClassNames(dir: string, destination: StyleDestination | null): Set<string> {
  const taken = new Set<string>()
  if (!destination) return taken
  // The destination's own selectors, read directly and without a size cap: a
  // name already ruled there is NEVER merged into (`insertRule` would overwrite).
  const own = readFileOrNull(join(dir, ...destination.file.split('/')))
  for (const match of (own ?? '').matchAll(CLASS_IN_CSS)) taken.add(match[1]!)
  const scan = (rel: string, pattern: RegExp, group: (match: RegExpExecArray) => string | undefined): void => {
    const text = readIfSmall(join(dir, ...rel.split('/')))
    if (text === null) return
    for (const match of text.matchAll(pattern)) {
      for (const name of (group(match as RegExpExecArray) ?? '').split(/\s+/)) if (name) taken.add(name)
    }
  }
  if (destination.kind === 'module') {
    scan(destination.file, CLASS_IN_CSS, (match) => match[1])
    return taken
  }
  const files = listWorkspaceFiles(dir).slice(0, MAX_SCANNED_FILES)
  for (const rel of files) {
    if (/\.css$/i.test(rel)) scan(rel, CLASS_IN_CSS, (match) => match[1])
    else if (/\.(tsx|jsx|ts|js|html)$/i.test(rel)) scan(rel, QUOTED_STRING, (match) => match[2])
  }
  return taken
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readIfSmall(path: string): string | null {
  try {
    return statSync(path).size > MAX_SCANNED_BYTES ? null : readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export type PastedHtmlOutcome =
  | { ok: true; created: readonly CreatedJsxLocation[]; summary: PastedHtmlSummary }
  | { ok: false; reason: string; message: string }

/**
 * Write the pasted fragment: refuse it whole, or land the markup and its
 * styles. `loc` is the container the elements go into (absolute file);
 * `anchor`, when given, is the sibling they are written beside.
 */
export function applyPastedHtmlInsert(
  dir: string,
  insert: PastedHtmlInsert,
  loc: { file: string; line: number; col: number },
  targetRel: string,
  anchor: { line: number; col: number; position: 'before' | 'after' | undefined } | null,
): PastedHtmlOutcome {
  const roots: PastedNode[] = [
    {
      name: insert.name,
      ...(insert.importSpecifier === undefined ? {} : { importSpecifier: insert.importSpecifier }),
      ...(insert.designSystemImport === undefined ? {} : { designSystemImport: insert.designSystemImport }),
      ...(insert.props ? { props: insert.props } : {}),
      ...(insert.children === undefined ? {} : { children: insert.children }),
    },
    ...(insert.siblings ?? []),
  ]
  const guarded = guardPastedNodes(roots)
  if (!guarded.ok) return { ok: false, reason: 'unsafe-paste', message: guarded.message }
  const css = insert.pastedHtml.css ?? ''
  if (css.length > MAX_PASTED_CSS_CHARS) {
    return { ok: false, reason: 'unsafe-paste', message: 'The stylesheet in that HTML is too large to write into your project in one paste.' }
  }

  const destination = css.trim() ? findPageStylesheet(dir, targetRel) : null
  const plan = planPastedStyles(roots, css, destination, takenClassNames(dir, destination))
  const [first, ...rest] = plan.roots as [PlannedNode, ...PlannedNode[]]

  const stylesheetPath = destination && plan.writes.length > 0 ? join(dir, ...destination.file.split('/')) : null
  const before = new Map<string, string>([[loc.file, readFileSync(loc.file, 'utf8')]])
  if (stylesheetPath) before.set(stylesheetPath, readFileSync(stylesheetPath, 'utf8'))

  const result = insertJsxElement({
    file: loc.file,
    line: loc.line,
    col: loc.col,
    ...(anchor ? { anchorLine: anchor.line, anchorCol: anchor.col, ...(anchor.position ? { position: anchor.position } : {}) } : {}),
    name: first.name,
    ...(first.props ? { props: first.props } : {}),
    ...(first.children === undefined ? {} : { children: first.children }),
    ...(rest.length > 0 ? { siblings: rest } : {}),
  })
  if (!result.ok) return { ok: false, ...result.refusal }

  if (destination && stylesheetPath) {
    try {
      const written = insertPastedRules(dir, destination.file, plan.writes)
      if (!written.applied) throw new Error('refusal' in written ? written.refusal.message : 'the stylesheet is not writable')
    } catch (err) {
      console.error('[studio] pasted html: the stylesheet write failed, restoring the page:', err)
      for (const [path, text] of before) writeSourceFile(path, text)
      return {
        ok: false,
        reason: 'stylesheet-write-failed',
        message: `Studio could not write the pasted styles into ${destination.file}, so nothing was pasted and your files are as they were.`,
      }
    }
  }

  return { ok: true, created: result.created, summary: { ...plan.summary, stylesheet: stylesheetPath && destination ? destination.file : null } }
}
