/**
 * studioCssWriteback — WS-6.3's `kind: 'css'` studio edit, end to end on the
 * server side: the edit's schema, the write-target path guard, and the
 * dispatch into `@core/css-codemods`.
 *
 * Split out of `studioWriteback.ts` (which owns the ts-morph/JSX edit kinds)
 * because a CSS edit is a genuinely different shape of write and shares none
 * of that module's machinery. Every other `StudioEdit` decodes its target
 * from a `rel:line:col` node id and hands it to an `ast-codemods` writer; a
 * CSS edit's target is a FILE + SELECTOR, resolved at LOAD time by
 * `studioCss.ts`'s `StyleRuleSource` map (`op: 'set'`), by the CLIENT's own
 * destination resolution for a rule with no source yet but an editable
 * stylesheet (`op: 'insert'`), or by the SERVER inventing a brand-new
 * co-located stylesheet when neither exists (`op: 'create'`) — Track B1, see
 * `styleRuleWriteback.ts`'s `resolveCssInsertDestination`. The dependency
 * runs one way — `studioWriteback.ts` imports this module's schema into the
 * `StudioEdit` union and calls `applyCssEdit`; this module imports nothing
 * back.
 *
 * ## Seven ops, one edit kind
 *
 *   - `op: 'set'` — an existing rule's declaration, `setDeclaration`, written
 *     where the cascade reads it (P3-C, WB-16) and, when the edit carries an
 *     `atRule`, inside that `@media`/`@container`/`@supports` block — a
 *     breakpoint/condition override (`style-03`, WB-31).
 *   - `op: 'unset'` — the same target, CLEARED (`removeDeclaration`,
 *     `style-03`). Its absence was a silent no-op: the client's diff only ever
 *     iterated the properties a rule has now, so removing one produced no edit
 *     at all and the property returned on the next reload.
 *   - `op: 'insert'` — a rule with NO existing source, but the CLIENT already
 *     resolved exactly one editable stylesheet to put it in: a brand-new
 *     class the user created, or the very first edit to any rule the load
 *     pipeline couldn't map (an `unmapped` rule the panel now knows how to
 *     place — see `styleRuleWriteback.ts`). Writes through `insertRule`,
 *     which merges into an exact-selector match if one already exists in the
 *     target file rather than duplicating it.
 *   - `op: 'create'` — a rule with NO existing source AND no editable
 *     stylesheet exists yet anywhere in the project. The client cannot
 *     resolve a destination for this case (it has no full-workspace file
 *     listing, only the stylesheets its already-parsed rules point at), so
 *     it names the PAGE this rule belongs to (`pageFile`, decoded from the
 *     rule's `scope.nodeId` — see `styleRuleWriteback.ts`'s
 *     `resolveCssInsertDestination`) and asks the server to invent a
 *     destination: detect this project's stylesheet naming convention
 *     (`detectStylesheetConvention`), create a co-located stylesheet next to
 *     the page, wire its `import` into the page, and write the rule's first
 *     declarations into it. Creating a file AND rewriting the importing
 *     `.tsx` in the same edit needs filesystem + AST access the client does
 *     not have, which is why this is server-decided rather than
 *     client-resolved like `insert`. With NO `pageFile` (P3-C, ERR-15 — a
 *     class on no element, with no page open) the stylesheet is created
 *     beside the app's entry module (`findEntryFile`: `index.html`'s module
 *     script, else `src/main.tsx` and friends) as `studio.css`, a plain
 *     global sheet, and imported there — every page can reach a class in it.
 *     This used to be the client's `no-editable-stylesheet` refusal. Only a
 *     project with no entry module at all still refuses (`no-app-entry`).
 *   - `op: 'keyframe-set'` / `'keyframe-unset'` / `'keyframes-insert'` — the
 *     same three moves one scope over, inside a `@keyframes` block (W5-5).
 *     Their schemas and their pure writers live in `studioCssKeyframes.ts`;
 *     the editability check, the containment guard, and the single
 *     `writeSourceFile` below are shared with every op above, which is the whole
 *     reason that module is pure. Their honest-target gate is
 *     `analyzeKeyframesTarget`, not `analyzeDeclarationTarget` — see
 *     `applyCssEdit`.
 *
 * All of them share the discriminator `kind: 'css'` (so the `StudioEdit`
 * union's top-level dispatch and `StudioEditRefusal.kind` stay unchanged),
 * disambiguated by `op`.
 *
 * ## Refusal is the point, not the error path
 *
 * Checks run in order, and any one of them can decline BEFORE a byte is
 * written. Together they are CLAUDE.md's "exactly one honest target"
 * invariant applied to CSS, which needs it more than JSX does — a selector
 * matches many elements, a rule can be redeclared, and a shorthand can undo a
 * longhand from further down the same block:
 *
 *   1. `classifyStylesheetEditability` — is this file hand-authored at all?
 *      A `.min.css`, a `dist/` build output, or a `.module.css` compile has
 *      no honest source at this layer (`meta-03` decision 3). `create` runs
 *      this too, against the co-located path it just computed — a page
 *      living inside a `build/`/`out/` directory that isn't excluded at the
 *      filesystem-safety layer still shouldn't get a stylesheet fabricated
 *      inside it.
 *   2. **`set` and `unset` only.** The declaration the CASCADE reads is the
 *      one written (P3-C, WB-16): a later duplicate block, a second
 *      declaration in one block, a covering shorthand after the longhand —
 *      the three shapes `analyzeDeclarationTarget` used to refuse — are
 *      written where they take effect, and a removal clears every
 *      declaration of the property. `setDeclaration` still refuses a covering
 *      `!important` (`important-override`), unparseable CSS (`css-syntax`)
 *      and a malformed scope (`invalid-at-rule`). Not a question for
 *      `insert`/`create` — a brand-new rule has no prior declaration to be
 *      shadowed by, and `insertRule` itself refuses to create a second block
 *      for an exact-selector match (see its doc).
 *   3. `resolveContainedCssPath` / `resolveContainedSourcePagePath` /
 *      `resolveStylesheetCreationPath` — is the target inside this
 *      workspace, on its REAL path, and outside every directory no Studio
 *      writer may touch (`isWorkspaceWritablePath`, P1-G)?
 *   4. **`create` only.** `ensureStylesheetImport` — does an import for this
 *      exact specifier already exist with the WRONG shape for the
 *      convention this stylesheet needs (a side-effect import where a
 *      CSS-Module default-import binding is required, or vice versa)? A
 *      mismatch here means the class this edit is about to write would be
 *      unreachable from the JSX no matter what — see this function's own
 *      doc, "reachability by construction".
 *
 * 1, 2, and 4 REFUSE with a specific, user-readable reason (surfaced as a
 * toast by `fsCodemodAdapter`'s refusal handler). 3 returns "not applied"
 * instead: nothing legitimate produces an out-of-workspace path — a client
 * only ever echoes back a `file`/`pageFile` this project's own load response
 * (or its own destination resolution) named — so there is no honest sentence
 * to show a user, only an attack to decline.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { QuoteKind } from 'ts-morph'
import { isWorkspaceWritablePath, listWorkspaceFiles, unwritableWorkspaceSegment, writeSourceFile } from '@core/page-parser'
import { createProject, relativeSpecifier, topLevelBindingNames } from '@core/ast-codemods'
import {
  AT_RULE_SCOPE_PATTERN,
  classifyStylesheetEditability,
  insertRule,
  removeDeclaration,
  setDeclaration,
} from '@core/css-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * A conditional block, as `name params` (`media (max-width: 768px)`,
 * `container card (min-width: 400px)`, `supports (display: grid)`) — the
 * scope `@core/css-codemods`' `cssAtRuleScope.ts` reads. Validated here so a
 * malformed one is a 400, not a refusal.
 */
export const AtRuleScopeSchema = Type.String({ pattern: AT_RULE_SCOPE_PATTERN })
import { findEntryFile } from '@core/studio-sync/collectPageStylesheets'
import { applyKeyframeEdit, CssKeyframeEditSchemas, isKeyframeEdit } from './studioCssKeyframes'

/**
 * One CSS declaration writeback (WS-6.3, `panel-02`) — `setDeclaration`
 * (`@core/css-codemods`), a postcss CST round-trip.
 *
 * `atRule` (`style-03`, P3-C WB-31) is the breakpoint/condition override's
 * conditional block, as `name params`: `media (max-width: 768px)`,
 * `container card (min-width: 400px)`, `supports (display: grid)`
 * (`@core/css-codemods`' `cssAtRuleScope.ts`). Present ⇒ the declaration is
 * written inside that block, creating it if it does not exist. Absent ⇒ the
 * rule's unconditional declarations, as before. The client resolves a
 * `contextId` to it from `site.breakpoints`/`site.conditions` — a
 * `@container` or `@supports` condition used to be refused client-side,
 * because only `@media` could be written.
 *
 * `file`/`selector` are `server/handlers/studioCss.ts`'s `StyleRuleSource`
 * for this rule id, resolved by the CLIENT at load time — a CSS rule's write
 * target is a FILE + SELECTOR, not a `line:col`, so it cannot be encoded in
 * `nodeId` the way every other edit kind's target is. `nodeId` is carried
 * anyway (synthesized, never decodes to a location) only so this kind
 * satisfies the shared `{ nodeId: string }` constraint every ordering/dedup
 * helper in `studioWriteback.ts` uses — `applyStudioEdit` special-cases
 * `kind === 'css'` before ever calling `studioEditLocation` on it, and the
 * synthesized id never collides with a real `rel:line:col`.
 */
const CssSetEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('set'),
  nodeId: Type.String(),
  file: Type.String(),
  selector: Type.String(),
  property: Type.String(),
  value: Type.String(),
  atRule: Type.Optional(AtRuleScopeSchema),
})

/**
 * One CSS declaration REMOVAL (`style-03`) — `removeDeclaration`. The exact
 * counterpart of `op: 'set'`, and it exists because clearing a property in the
 * inspector used to reach no code path at all: the diff only iterated the
 * properties a rule has NOW, so a removed one produced no edit, no toast, and
 * came back on the next reload.
 *
 * P3-C (WB-16): it clears EVERY declaration of the property the matching
 * rules carry — removing only the first of two duplicates left the second in
 * effect, which is why this used to refuse on a duplicate.
 */
const CssUnsetEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('unset'),
  nodeId: Type.String(),
  file: Type.String(),
  selector: Type.String(),
  property: Type.String(),
  atRule: Type.Optional(AtRuleScopeSchema),
})

/**
 * One brand-new-rule writeback into an EXISTING stylesheet (Track B1) —
 * `insertRule`. `file` is the destination the CLIENT resolved
 * (`resolveCssInsertDestination` in `styleRuleWriteback.ts`) since, unlike
 * `set`, there is no `styleRuleSources` entry to read one from — this is the
 * rule's FIRST write. `declarations` carries the rule's FULL current
 * declaration set (not a diff — there is nothing to diff against yet),
 * kebab-cased the same way a `set` edit's `property` is. `atRule`, when
 * present, wraps the new rule in that conditional block (matching or creating
 * it) — unused by B1 itself (which only ever inserts a rule's BASE
 * declarations, same scope limit `set` has), carried so the shape is ready
 * for the breakpoint-insert work item without another schema change.
 */
const CssInsertEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('insert'),
  nodeId: Type.String(),
  file: Type.String(),
  selector: Type.String(),
  declarations: Type.Record(Type.String(), Type.String()),
  atRule: Type.Optional(AtRuleScopeSchema),
})

/**
 * One brand-new-rule writeback into a STYLESHEET THAT DOES NOT EXIST YET
 * (Track B1's deferred middle branch) — `applyCssCreateEdit` below.
 * `pageFile` is the workspace-relative `.tsx`/`.jsx`/`.ts`/`.js` page this
 * rule belongs to (the CLIENT decodes it from the rule's `scope.nodeId` —
 * see `styleRuleWriteback.ts`'s `resolveCssInsertDestination` — because a
 * rule with no page association at all, e.g. a freestanding class created
 * with no element selected, has nowhere honest to co-locate a NEW file with,
 * and the client refuses rather than guessing). Everything else matches
 * `CssInsertEditSchema`: `declarations` is the FULL current bag, `atRule`
 * is carried for parity though unused by this pass.
 *
 * `pageFile` absent ⇒ the stylesheet goes beside the app's ENTRY module
 * instead (P3-C, ERR-15) — see this module's doc and `cssCreateImportTarget`.
 */
const CssCreateEditSchema = Type.Object({
  kind: Type.Literal('css'),
  op: Type.Literal('create'),
  nodeId: Type.String(),
  pageFile: Type.Optional(Type.String()),
  selector: Type.String(),
  declarations: Type.Record(Type.String(), Type.String()),
  atRule: Type.Optional(AtRuleScopeSchema),
})

/**
 * B1 is first through this three-way seam — `StudioEditSchema` in
 * `studioWriteback.ts` folds `CssEditSchema` in alongside two more edit kinds
 * two OTHER work items add next (B2's `class`, E2.4's `insert-slot`/
 * `promote-component`). Nothing here constrains how those extend the outer
 * union; they add their own sibling schemas the same way this module already
 * sits beside `studioStructuralWriteback.ts`'s `StructuralEditSchemas`.
 */
export const CssEditSchema = Type.Union([
  CssSetEditSchema,
  CssUnsetEditSchema,
  CssInsertEditSchema,
  CssCreateEditSchema,
  // W5-5's three `@keyframes` ops. Their schemas and their (pure) writers live
  // in `studioCssKeyframes.ts`; this module still owns the path guard, the
  // editability check, and the single `writeSourceFile` — see `applyCssEdit`.
  ...CssKeyframeEditSchemas,
])

export type CssEdit = Static<typeof CssEditSchema>
export type CssCreateEdit = Extract<CssEdit, { op: 'create' }>

/**
 * `applyCssEdit`'s outcome. `refusal` is a NAMED, expected result carrying a
 * sentence for the user — not an error. `applied: false` with no refusal
 * means "no honest target to write, and nothing worth saying about it"
 * (an out-of-workspace or missing file). `createdStylesheet` is populated
 * only for a successful `op: 'create'` edit — the workspace-relative path
 * the server actually invented, so the caller can show the user WHICH file
 * was created (never silent — see this module's doc) and so the client can
 * make the same rule writable through the ordinary `set` path on its very
 * next edit without a reload (`recordCreatedStylesheet` in
 * `styleRuleWriteback.ts`).
 */
export type CssEditOutcome =
  | { applied: boolean; createdStylesheet?: { file: string } }
  | { applied: false; refusal: { reason: string; message: string } }

/**
 * Splits a client-supplied, workspace-relative path into safe segments, or
 * `null` if it fails ANY check every write/creation target in this module
 * shares: absolute/UNC/drive-letter forms, `..`/`.`/empty segments on EITHER
 * separator, a segment naming a directory no Studio writer may touch
 * (`unwritableWorkspaceSegment`: `.studio`, `.git`, `node_modules`, build
 * output, `.claude` — case-folded, the way the filesystem resolves it), or the
 * wrong extension. Pure string validation — the real-path half is
 * `isWorkspaceWritablePath`, each resolver's next step.
 */
function safeRelSegments(fileRel: string, extensionTest: RegExp): string[] | null {
  if (fileRel.length === 0) return null
  if (isAbsolute(fileRel)) return null
  if (/^[a-zA-Z]:/.test(fileRel)) return null // Windows drive path
  if (fileRel.startsWith('\\\\') || fileRel.startsWith('//')) return null // UNC path
  if (!extensionTest.test(fileRel)) return null

  const segments = fileRel.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (unwritableWorkspaceSegment(fileRel) !== null) return null
  return segments
}

/** `statSync` (links followed) says a regular file is there. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * An EXISTING file at a client-supplied `fileRel` that this module may write,
 * as an absolute path, or `null`. The shape guard above, then the shared
 * write predicate on the REAL path (`isWorkspaceWritablePath`): a workspace
 * can arrive from GitHub and git stores symlinks, so `styles/theme.css` where
 * `styles -> .studio` (or `-> ../../outside`) is refused for where it LANDS,
 * not for how it is spelled. `null` when the file does not exist — a target
 * pointing nowhere is worse than refusing the edit.
 */
function resolveWritableExistingFile(dir: string, fileRel: string, extensionTest: RegExp): string | null {
  const segments = safeRelSegments(fileRel, extensionTest)
  if (!segments) return null
  const resolved = join(dir, ...segments)
  if (!isWorkspaceWritablePath(dir, resolved)) return null
  return isRegularFile(resolved) ? resolved : null
}

/**
 * Validates that `fileRel` — the project-relative `.css` path `studioCss.ts`'s
 * `StyleRuleSource` mapped a `StyleRule.id` to at load time — is safe to
 * write, and resolves it to an absolute path. A literal `.css` extension is
 * required: the codemod parses real CSS syntax, and `studioCss.ts` never maps
 * a `.scss`/`.sass`/`.less` file for exactly this reason (see its doc).
 */
function resolveContainedCssPath(dir: string, fileRel: string): string | null {
  return resolveWritableExistingFile(dir, fileRel, /\.css$/i)
}

/** A real page-source-file extension — the set `applyStudioEdit` already treats as app source. */
const SOURCE_FILE_EXT_RE = /\.(tsx|jsx|ts|js)$/i

/**
 * Validates a client-supplied PAGE file path (Track B1's `op: 'create'`
 * branch) — the page this module adds a stylesheet import to, so a write
 * target in its own right — the same way `resolveContainedCssPath` validates
 * a `.css` target. `null` when the file does not exist: there is no page to
 * co-locate a new stylesheet with if the page itself cannot be found.
 */
function resolveContainedSourcePagePath(dir: string, fileRel: string): string | null {
  return resolveWritableExistingFile(dir, fileRel, SOURCE_FILE_EXT_RE)
}

/**
 * Validates the STYLESHEET this module is about to CREATE — same shape guard
 * and shared real-path predicate as `resolveContainedCssPath`, but the file
 * is allowed not to exist yet: `isWorkspaceWritablePath` resolves it through
 * its deepest existing ancestor ("check the write, not the intent" — the
 * parent is the already-validated page's own directory, but it is re-checked
 * rather than trusted). Refuses if the target already exists as something
 * other than a plain file: a directory, or a DANGLING symlink — `writeFileSync`
 * follows a link, so creating "a new stylesheet" there would create a file
 * wherever the link points, outside the project included.
 */
function resolveStylesheetCreationPath(dir: string, fileRel: string): string | null {
  const segments = safeRelSegments(fileRel, /\.css$/i)
  if (!segments) return null
  const resolved = join(dir, ...segments)
  if (!isWorkspaceWritablePath(dir, resolved)) return null
  if (existsSync(resolved) && !isRegularFile(resolved)) return null
  return resolved
}

/**
 * Track B1's create-branch naming convention: co-locate a `.module.css` next
 * to the page if this PROJECT already leans on CSS Modules, a plain `.css`
 * otherwise. Counts every `*.module.css` vs. every other `*.css` file in the
 * workspace (`listWorkspaceFiles` — the same bounded, symlink-free walk the
 * download zip and the GitHub import writer already share) and picks the
 * majority. A tie — including the common "no stylesheet anywhere yet" case —
 * resolves to plain `.css`: it needs no JS binding at all, so it is the
 * lower-risk default when nothing in the project says otherwise (see
 * `ensureStylesheetImport`'s doc, "reachability by construction").
 */
function detectStylesheetConvention(dir: string): 'css' | 'module' {
  let moduleCount = 0
  let plainCount = 0
  for (const file of listWorkspaceFiles(dir)) {
    if (/\.module\.css$/i.test(file)) moduleCount += 1
    else if (/\.css$/i.test(file)) plainCount += 1
  }
  return moduleCount > plainCount ? 'module' : 'css'
}

/** The co-located stylesheet's workspace-relative path for a validated page path's segments. */
function coLocatedStylesheetRelPath(pageSegments: readonly string[], convention: 'css' | 'module'): string {
  const baseName = pageSegments[pageSegments.length - 1]!.replace(SOURCE_FILE_EXT_RE, '')
  const fileName = convention === 'module' ? `${baseName}.module.css` : `${baseName}.css`
  return [...pageSegments.slice(0, -1), fileName].join('/')
}

/** `ensureStylesheetImport`'s result — success, or a NAMED refusal (see that function's doc). */
type StylesheetImportOutcome =
  | { ok: true }
  | { ok: false; reason: 'stylesheet-import-shape-mismatch'; message: string }

/**
 * Wires the co-located stylesheet's `import` into the page, or confirms one
 * is already there. Idempotent — a retried save (the client autosaves on a
 * timer; two batches can legitimately both try to create the same
 * stylesheet if the first response was lost) finds its own prior import and
 * does nothing.
 *
 * ## Reachability by construction
 *
 * A `.module.css` file's classes are reachable ONLY through the JS binding
 * its default import provides (`import styles from './Page.module.css'` →
 * `styles.foo`) — the runtime class name is a compiler-generated hash, so a
 * bare literal `className="foo"` against it renders as nothing. A plain
 * `.css` file is the opposite: side-effect only (`import './Page.css'`), no
 * binding, and a literal `className="foo"` is exactly right. This function
 * NEVER produces the mismatched pairing — it branches on `convention` for
 * every import it writes, so a `.module.css` always gets a binding and a
 * plain `.css` never does. The one case that could still go wrong is an
 * import for this EXACT specifier already existing with the wrong shape
 * (e.g. an earlier, now-inconsistent run, or a human hand-edit) — that is
 * refused by name here rather than silently left mismatched, which is the
 * concrete form Track B1's "refuse rather than write something that renders
 * as nothing" requirement takes for the create branch.
 */
function ensureStylesheetImport(pageAbsPath: string, cssAbsPath: string, convention: 'css' | 'module'): StylesheetImportOutcome {
  // `createProject()` rather than a bare `new Project(...)`: it carries the
  // CRLF-preserving file system every other codemod writes through, so adding
  // an import to a page in a Windows checkout does not convert the file.
  const project = createProject()
  // Single-quote imports, matching every other `ast-codemods` writer that
  // creates a fresh import declaration (`detachComponent.ts`,
  // `extractComponentCopy.ts`, `extractSubtreeToComponent.ts`,
  // `swapComponentInstance.ts`) — ts-morph's own default is double quotes.
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const pageSourceFile = project.addSourceFileAtPath(pageAbsPath)
  const specifier = relativeSpecifier(pageAbsPath, cssAbsPath)

  const existing = pageSourceFile.getImportDeclarations().find((decl) => decl.getModuleSpecifierValue() === specifier)

  if (existing) {
    const hasBinding = existing.getDefaultImport() !== undefined
    if (convention === 'module' && !hasBinding) {
      return {
        ok: false,
        reason: 'stylesheet-import-shape-mismatch',
        message:
          `${specifier} is already imported without a binding, but this project's convention needs a CSS-Module ` +
          'default import to reach a class in it. Studio will not silently write an unreachable class.',
      }
    }
    if (convention === 'css' && hasBinding) {
      return {
        ok: false,
        reason: 'stylesheet-import-shape-mismatch',
        message:
          `${specifier} is already imported as a CSS Module, but this project's convention needs a plain ` +
          'side-effect import here. Studio will not silently write an unreachable class.',
      }
    }
    return { ok: true }
  }

  if (convention === 'module') {
    const bound = topLevelBindingNames(pageSourceFile)
    let localName = 'styles'
    let n = 2
    while (bound.has(localName)) {
      localName = `styles${n}`
      n += 1
    }
    pageSourceFile.addImportDeclaration({ moduleSpecifier: specifier, defaultImport: localName })
  } else {
    pageSourceFile.addImportDeclaration({ moduleSpecifier: specifier })
  }
  pageSourceFile.saveSync()
  return { ok: true }
}

/** The stylesheet `op: 'create'` makes beside the app entry when no page anchors the class (ERR-15). */
const ENTRY_STYLESHEET_NAME = 'studio.css'

/**
 * The workspace-relative (POSIX) source file an `op: 'create'` edit adds its
 * stylesheet `import` to, or `null` when there is none: the named `pageFile`,
 * or — absent — the app's entry module (`findEntryFile`, the same answer the
 * entry-stylesheet walk uses, so the new sheet is on the path the load already
 * collects global CSS from). Shape-checked like every client path; the caller
 * still resolves it through `resolveContainedSourcePagePath` before writing.
 *
 * Exported because two other readers must name the SAME file: the syntax
 * guard (a broken importer is never written) and the batch's touched-file set
 * (its import list gains a line).
 */
export function cssCreateImportTarget(dir: string, edit: CssCreateEdit): string | null {
  if (edit.pageFile !== undefined) {
    const segments = safeRelSegments(edit.pageFile, SOURCE_FILE_EXT_RE)
    return segments ? segments.join('/') : null
  }
  const entry = findEntryFile(dir)
  if (entry === undefined) return null
  const rel = relative(resolve(dir), entry)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null
  const segments = safeRelSegments(rel.split(sep).join('/'), SOURCE_FILE_EXT_RE)
  return segments ? segments.join('/') : null
}

/**
 * `op: 'create'` — Track B1's deferred middle branch, now landed. Resolves
 * the page, detects the project's stylesheet convention, computes and
 * validates the co-located stylesheet's path, wires the page's `import`
 * (refusing first if an existing import for it has the wrong shape), then
 * writes the rule's declarations into it (creating the file if it does not
 * exist yet, merging into it if a prior `create`/hand-edit already put
 * something there).
 */
function applyCssCreateEdit(dir: string, edit: CssCreateEdit): CssEditOutcome {
  const importer = cssCreateImportTarget(dir, edit)
  if (importer === null) {
    return edit.pageFile === undefined
      ? {
          applied: false,
          refusal: {
            reason: 'no-app-entry',
            message:
              'This project has no stylesheet yet and no app entry module (index.html’s module script, or ' +
              'src/main.tsx) to import a new one from, so the class was not written. Open the page it belongs to, ' +
              'then change it again.',
          },
        }
      : { applied: false }
  }
  const importerSegments = importer.split('/')
  const pageAbsPath = resolveContainedSourcePagePath(dir, importer)
  if (pageAbsPath === null) return { applied: false }

  // A page gets a sheet co-located with it, in this project's convention. The
  // app ENTRY gets a plain global `studio.css`: a CSS Module's classes reach
  // only the file that imports it, and the entry renders none of the markup.
  const convention = edit.pageFile === undefined ? 'css' : detectStylesheetConvention(dir)
  const cssRelPath =
    edit.pageFile === undefined
      ? [...importerSegments.slice(0, -1), ENTRY_STYLESHEET_NAME].join('/')
      : coLocatedStylesheetRelPath(importerSegments, convention)

  const editability = classifyStylesheetEditability(cssRelPath)
  if (editability.kind === 'compiled') {
    return { applied: false, refusal: { reason: 'compiled-stylesheet', message: editability.reason } }
  }

  const cssAbsPath = resolveStylesheetCreationPath(dir, cssRelPath)
  if (cssAbsPath === null) return { applied: false }

  const importOutcome = ensureStylesheetImport(pageAbsPath, cssAbsPath, convention)
  if (!importOutcome.ok) {
    return { applied: false, refusal: { reason: importOutcome.reason, message: importOutcome.message } }
  }

  const existingCss = existsSync(cssAbsPath) ? readFileSync(cssAbsPath, 'utf8') : ''
  const result = insertRule(existingCss, edit.selector, edit.declarations, { atRule: edit.atRule })
  if (result.changed) writeSourceFile(cssAbsPath, result.css)

  return { applied: true, createdStylesheet: { file: cssRelPath } }
}

/**
 * Apply one `kind: 'css'` edit to the stylesheet it names, under `dir`.
 * See this module's doc for the check order per `op` and why some of them
 * refuse with a reason while others simply decline.
 */
export function applyCssEdit(dir: string, edit: CssEdit): CssEditOutcome {
  if (edit.op === 'create') return applyCssCreateEdit(dir, edit)

  const editability = classifyStylesheetEditability(edit.file)
  if (editability.kind === 'compiled') {
    return { applied: false, refusal: { reason: 'compiled-stylesheet', message: editability.reason } }
  }

  const filePath = resolveContainedCssPath(dir, edit.file)
  if (filePath === null) return { applied: false }

  const cssText = readFileSync(filePath, 'utf8')

  if (isKeyframeEdit(edit)) {
    // A keyframe step is not a selector's declaration in the cascade, so the
    // class writer's rules do not apply. The equivalent question for a `@keyframes`
    // block — is there exactly one of them by this name? — is asked by
    // `analyzeKeyframesTarget` inside `applyKeyframeEdit`, which refuses with
    // its own sentence.
    const outcome = applyKeyframeEdit(cssText, edit)
    if ('refusal' in outcome) {
      return { applied: false, refusal: outcome.refusal }
    }
    if (outcome.changed) writeSourceFile(filePath, outcome.css)
    return { applied: true }
  }

  if (edit.op === 'insert') {
    // No `analyzeDeclarationTarget` gate here — a brand-new rule has no
    // prior declaration for a later block/shorthand to shadow, and
    // `insertRule` itself refuses to create a duplicate block for an
    // exact-selector match (merges into it instead — see its doc).
    const result = insertRule(cssText, edit.selector, edit.declarations, { atRule: edit.atRule })
    if (result.changed) writeSourceFile(filePath, result.css)
    return { applied: true }
  }

  // `set` and `unset` write the declaration the cascade reads (P3-C, WB-16),
  // decided on the SAME text about to be written, inside `atRule`'s block when
  // there is one. `applied: true` even for a no-op: the requested state IS the
  // state on disk, and reporting a skip would warn the user about nothing.
  const scope = edit.atRule ? { atRule: edit.atRule } : {}
  const result =
    edit.op === 'unset'
      ? removeDeclaration(cssText, edit.selector, edit.property, scope)
      : setDeclaration(cssText, edit.selector, edit.property, edit.value, scope)
  if (!result.ok) return { applied: false, refusal: { reason: result.refusal.reason, message: result.refusal.message } }
  if (result.changed) writeSourceFile(filePath, result.css)
  return { applied: true }
}
