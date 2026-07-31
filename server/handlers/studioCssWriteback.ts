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
 * `studioCss.ts`'s `StyleRuleSource` map, and its writer is a postcss CST
 * round-trip. The dependency runs one way — `studioWriteback.ts` imports this
 * module's schema into the `StudioEdit` union and calls `applyCssEdit`; this
 * module imports nothing back.
 *
 * ## Refusal is the point, not the error path
 *
 * Three checks run in order, and any one of them can decline BEFORE a byte is
 * written. Together they are CLAUDE.md's "exactly one honest target"
 * invariant applied to CSS, which needs it more than JSX does — a selector
 * matches many elements, a rule can be redeclared, and a shorthand can undo a
 * longhand from further down the same block:
 *
 *   1. `classifyStylesheetEditability` — is this file hand-authored at all?
 *      A `.min.css`, a `dist/` build output, or a `.module.css` compile has
 *      no honest source at this layer (`meta-03` decision 3).
 *   2. `analyzeDeclarationTarget` — would the write land somewhere the
 *      cascade actually honours? A duplicated selector or a covering
 *      shorthand makes `setDeclaration`'s first-match rule disagree with the
 *      last-declaration-wins cascade, so the file would change and the canvas
 *      would not.
 *   3. `resolveContainedCssPath` — is the target inside this workspace?
 *
 * 1 and 2 REFUSE with a specific, user-readable reason (surfaced as a toast
 * by `fsCodemodAdapter`'s refusal handler). 3 returns "not applied" instead:
 * nothing legitimate produces an out-of-workspace path — a client only ever
 * echoes back a `file` this project's own load response mapped — so there is
 * no honest sentence to show a user, only an attack to decline.
 */
import { isAbsolute, join, resolve, sep } from 'node:path'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { analyzeDeclarationTarget, classifyStylesheetEditability, setDeclaration } from '@core/css-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One CSS declaration writeback (WS-6.3, `panel-02`) — `setDeclaration`
 * (`@core/css-codemods`), a postcss CST round-trip. Scoped to a rule's BASE
 * declarations only this pass — a breakpoint/condition-scoped override
 * (`@media`) is a real, documented gap; `setDeclarationAtMedia` is ready for
 * it, this edit kind just doesn't carry a query yet.
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
export const CssEditSchema = Type.Object({
  kind: Type.Literal('css'),
  nodeId: Type.String(),
  file: Type.String(),
  selector: Type.String(),
  property: Type.String(),
  value: Type.String(),
})

export type CssEdit = Static<typeof CssEditSchema>

/**
 * `applyCssEdit`'s outcome. `refusal` is a NAMED, expected result carrying a
 * sentence for the user — not an error. `applied: false` with no refusal
 * means "no honest target to write, and nothing worth saying about it"
 * (an out-of-workspace or missing file).
 */
export type CssEditOutcome =
  | { applied: boolean }
  | { applied: false; refusal: { reason: string; message: string } }

/**
 * Validates that `fileRel` — the project-relative `.css` path `studioCss.ts`'s
 * `StyleRuleSource` mapped a `StyleRule.id` to at load time — is safe to
 * write, and resolves it to an absolute path.
 *
 * Same adversarial posture as `studioWriteback.ts`'s `resolveContainedAssetPath`:
 * reject absolute/UNC/drive-letter forms, `..`/`.`/empty segments on EITHER
 * separator, and any `EXCLUDED_WORKSPACE_DIR_NAMES` segment; require a literal
 * `.css` extension (the codemod parses real CSS syntax, and `studioCss.ts`
 * never maps a `.scss`/`.sass`/`.less` file for exactly this reason — see its
 * doc); then require CONTAINMENT ON THE REAL PATH after resolving symlinks —
 * a workspace can arrive from GitHub, and git stores symlinks, so a textual
 * check alone is bypassable. `null` on any violation, or when the file does
 * not exist — a stylesheet pointing nowhere is worse than refusing the edit.
 */
function resolveContainedCssPath(dir: string, fileRel: string): string | null {
  if (fileRel.length === 0) return null
  if (isAbsolute(fileRel)) return null
  if (/^[a-zA-Z]:/.test(fileRel)) return null // Windows drive path
  if (fileRel.startsWith('\\\\') || fileRel.startsWith('//')) return null // UNC path
  if (!/\.css$/i.test(fileRel)) return null

  const segments = fileRel.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

  const root = resolve(dir)
  const resolved = resolve(join(dir, ...segments))
  if (resolved !== root && !resolved.startsWith(root + sep)) return null

  let real: string
  try {
    real = realpathSync(resolved)
  } catch {
    return null // missing file — nowhere honest to write a declaration
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null

  return resolved
}

/**
 * Apply one `kind: 'css'` edit to the stylesheet it names, under `dir`.
 * See this module's doc for the three-check order and why two of them refuse
 * with a reason while the third simply declines.
 */
export function applyCssEdit(dir: string, edit: CssEdit): CssEditOutcome {
  const editability = classifyStylesheetEditability(edit.file)
  if (editability.kind === 'compiled') {
    return { applied: false, refusal: { reason: 'compiled-stylesheet', message: editability.reason } }
  }

  const filePath = resolveContainedCssPath(dir, edit.file)
  if (filePath === null) return { applied: false }

  const cssText = readFileSync(filePath, 'utf8')

  // The honest-target gate. Runs on the SAME text about to be written, so its
  // verdict cannot go stale between the check and the write.
  const analysis = analyzeDeclarationTarget(cssText, edit.selector, edit.property)
  if (!analysis.ok) {
    return { applied: false, refusal: { reason: analysis.refusal.reason, message: analysis.refusal.message } }
  }

  const result = setDeclaration(cssText, edit.selector, edit.property, edit.value)
  if (result.changed) writeFileSync(filePath, result.css, 'utf8')
  return { applied: true }
}
