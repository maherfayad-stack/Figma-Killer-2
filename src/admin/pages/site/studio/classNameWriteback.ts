/**
 * classNameWriteback — Track B2's client half: turns a `PageNode.classIds`
 * drift since the last save (`loadedValuesBaseline.ts`'s `collectClassIdsDrift`)
 * into `kind: 'class'` edits (`setJsxClassName`, `server/handlers/
 * studioEditSchemas.ts`) — the real write behind Phase 0 item 0.6's
 * honesty-only stopgap (`classAssignmentUnsavedNotice.ts`).
 *
 * Split out of `fsCodemodAdapter.ts` for the same reason `styleRuleWriteback.ts`
 * is its own file (`module-size-budgets`'s 700-line ceiling, and "one thing to
 * get right, tested on its own"): converting an id-based drift into a
 * JSX-editable class-token diff needs the rule registry (id -> class NAME)
 * that only `site.styleRules` carries.
 *
 * ## Not every drift is writable
 *
 * `hasWritableSourceLocation` is the exact per-node gate every other edit
 * kind asks before emitting a `prop`/`style`/`text` edit — a `.map` row or a
 * synthetic root (`index:body`) has no single JSX location a class token
 * could land on. Those drifts go into `unwritable`: the direct replacement
 * for Phase 0.6's blanket "class changes can't be written yet" toast, now
 * scoped to the genuinely unwritable subset instead of firing for every
 * class change in the project.
 *
 * An INLINED (shared-component) node id IS writable — the write lands on the
 * component's own file, exactly like any other prop/style edit on that node
 * — `isSharedSourceNodeId` (kind-agnostic on the id shape) already tells the
 * save route to reload afterwards for it, same as it always has.
 *
 * ## A pure reorder writes nothing
 *
 * Class token ORDER inside a `className` attribute has no effect on the
 * cascade — that is decided by declaration order in the stylesheet, not
 * attribute order — so a reorder-only drift (`addedClassIds`/`removedClassIds`
 * both empty, `reordered: true`) produces no edit and no toast. There is
 * nothing honest to persist.
 *
 * ## Per-ATTRIBUTE refusals are not decided here; per-TOKEN ones are
 *
 * `setJsxClassName` (`@core/ast-codemods`) is the only place that has
 * actually read the `className` expression, so it is the only place that can
 * refuse on the SHAPE of that attribute (a CSS Modules binding, a dynamic
 * template, a spread attribute, an unrecognized function call). Those
 * refusals come back from the server on `StudioEditBatchResult.refusals`
 * with `kind: 'class'`, surfaced by `fsCodemodAdapter.ts`'s existing
 * `REFUSAL_TITLES` toast loop exactly like `detach`/`swap`/`css` already are.
 *
 * What a TOKEN spells, though, is this module's question, because only the
 * client holds the `StyleRule.id -> (file, selector)` registry — see
 * `resolveClassToken`, and `tokenRefusals` for the cases it declines rather
 * than guesses.
 */
import {
  getNodeDisplayName,
  hasWritableSourceLocation,
  isGeneratedClass,
  isImportedStyleRuleId,
  type Page,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'
import { registry } from '@core/module-engine'
import { collectClassIdsDrift } from './loadedValuesBaseline'
import { buildClassPageIndex, getStudioStyleRuleSources, resolveCssInsertDestination } from './styleRuleWriteback'
import { getStudioStyledRuleSources, styledClassRefusal } from './styledRuleSources'
import type { ClassAssignmentDriftDetail } from '@site/panels/classAssignmentUnsavedNotice'

/**
 * One class token on the wire — `server/handlers/studioEditSchemas.ts`'s
 * `ClassNameTokenSchema`. See `resolveClassToken` for which shape a rule gets
 * and why.
 */
export type ClassNameEditToken =
  | { kind: 'literal'; token: string }
  | { kind: 'module'; file: string; local: string }

/** One `kind: 'class'` edit, matching `server/handlers/studioEditSchemas.ts`'s `ClassEditSchema`. */
export interface ClassNameEditPayload {
  kind: 'class'
  nodeId: string
  add: ClassNameEditToken[]
  remove: ClassNameEditToken[]
}

/** One class that could not be turned into a writable token, and the sentence saying why. */
export interface ClassTokenRefusal {
  nodeLabel: string
  className: string
  reason: string
  message: string
}

export interface ClassNameEditPlan {
  edits: ClassNameEditPayload[]
  /** Drifts with no writable source location at all — genuinely can never be written from this node id. */
  unwritable: ClassAssignmentDriftDetail[]
  /**
   * Classes whose TOKEN could not be resolved honestly (`style-02`). Reported,
   * never guessed at — and the affected node ids are also returned in
   * `refusedNodeIds` so the caller can hold their `classIds` baseline back and
   * try again on the next save.
   */
  tokenRefusals: ClassTokenRefusal[]
  /** Node ids whose drift was NOT fully sent — their baseline must not advance. */
  refusedNodeIds: string[]
}

type ClassTokenResult =
  | { ok: true; token: ClassNameEditToken }
  | { ok: false; reason: string; message: string }

/**
 * The token that ATTACHES this rule's class to an element in the user's real
 * source — `style-02`, and the worst correctness bug this module has had.
 *
 * The old answer was `styleRules[id].name`, unconditionally. For a class that
 * came out of a `*.module.css` that name is Studio's OWN compiled hash
 * (`styleCompile.ts`'s `<fileBase>_<local>__<sha1-5>`), computed so the canvas
 * can render the module's cascade. Writing it into the user's JSX produced a
 * `className` token that matches something only inside Studio's iframe and
 * NOTHING in their actual app — a write that looks like it worked, is really
 * on disk, and styles nothing.
 *
 * So the token is resolved from the rule's SOURCE FILE, not its name:
 *
 *   - a `*.module.css` source ⇒ a `module` token (`styles.<local>`), where
 *     `local` is the name as written in that file: `displayName` for an
 *     imported rule (`studioCss.ts` sets it from the inverse class map), or
 *     the rule's own name for one the editor authored into that file.
 *   - anything else ⇒ a `literal` token. This is right for a plain `.css`
 *     rule, for a Tailwind utility (no source at all, and the class name IS
 *     the DOM name), for a framework-generated class, and for a `:global(...)`
 *     class inside a module file (never renamed, so it has no `displayName`
 *     and is an ordinary name).
 *   - a rule the editor authored that has no source YET resolves through
 *     `resolveCssInsertDestination`, the same destination its declarations
 *     will be inserted into on this very save — so the pair always agrees.
 *   - a CSS-in-JS synthetic class REFUSES (W4-4 Phase B). There is no class
 *     token behind it AT ALL: `Card_sc__a1b2c3` is a hash Studio computed so
 *     the canvas could render the template, styled-components generates its
 *     own name at runtime, and the `.tsx` holds neither. The old code fell
 *     through to the `isImportedStyleRuleId` literal branch below and returned
 *     that hash — so ADDING the class wrote a token that matches nothing in
 *     the user's real app, and REMOVING it made `setJsxClassName` search for a
 *     token that was never there, no-op with `{ ok: true }`, and leave the
 *     canvas showing a change the file does not have. Exactly `style-02`'s
 *     CSS-Modules bug, reachable again through a different door.
 *   - a `create` destination REFUSES: the server picks that file's name and
 *     convention (`detectStylesheetConvention`), so the client cannot yet
 *     tell whether the class is reachable as a literal or only as a binding.
 *     One save later `recordCreatedStylesheet` has the answer and the token
 *     resolves normally — which is why a refusal here holds the node's
 *     `classIds` baseline back instead of advancing past it.
 */
function resolveClassToken(
  classId: string,
  styleRules: Record<string, StyleRule>,
  pageIndex: ReadonlyMap<string, string>,
): ClassTokenResult | null {
  const rule = styleRules[classId]
  if (!rule) return null // no rule behind the id — nothing to name (shouldn't happen)

  // A framework-generated utility (`.text-color-metal`, a typography step) is
  // regenerated from `.studio/framework.json`, never from a `.css` file, and
  // its NAME is what the DOM carries everywhere it renders. It has no source
  // and never will — resolving a destination for it would be nonsense.
  if (isGeneratedClass(rule)) return { ok: true, token: { kind: 'literal', token: rule.name } }

  const moduleToken = (file: string, local: string | undefined): ClassTokenResult =>
    local ? { ok: true, token: { kind: 'module', file, local } } : { ok: true, token: { kind: 'literal', token: rule.name } }

  // W4-4 Phase B — checked before every branch below, because a styled rule
  // has no `styleRuleSources` entry and WOULD reach the imported-rule literal
  // fallback. See this function's doc.
  const styled = getStudioStyledRuleSources()[classId]
  if (styled) return { ok: false, ...styledClassRefusal(styled.componentName) }

  const source = getStudioStyleRuleSources()[classId]
  if (source) {
    if (!/\.module\.css$/i.test(source.file)) return { ok: true, token: { kind: 'literal', token: rule.name } }
    // `displayName` is the local name for an IMPORTED module rule; a rule the
    // editor authored into that file carries its local name as `name`. A
    // `:global(...)` class has neither and falls back to the literal.
    return moduleToken(source.file, rule.displayName ?? (isImportedStyleRuleId(classId) ? undefined : rule.name))
  }

  // No source at all. An imported rule that stayed unmapped is Tailwind /
  // compiled output, whose class name IS the DOM name.
  if (isImportedStyleRuleId(classId)) return { ok: true, token: { kind: 'literal', token: rule.name } }

  const destination = resolveCssInsertDestination(rule, pageIndex)
  if (!destination.ok) return { ok: false, reason: destination.reason, message: destination.message }
  if (destination.kind === 'create') {
    return {
      ok: false,
      reason: 'stylesheet-not-created-yet',
      message:
        `Studio is creating a stylesheet next to ${destination.pageFile} for this class in this save. Until that ` +
        'file exists it cannot tell whether the class is reachable by name or only through a CSS-Module binding, ' +
        'so it will attach the class on your next change rather than guess.',
    }
  }
  return /\.module\.css$/i.test(destination.file)
    ? moduleToken(destination.file, rule.name)
    : { ok: true, token: { kind: 'literal', token: rule.name } }
}

/**
 * Diffs every node's `classIds` against the load-time baseline
 * (`collectClassIdsDrift`) and splits the result into `kind: 'class'` edits
 * ready to send, plus the subset with no writable source location at all —
 * see this module's doc for why those two lists, and why a reorder-only
 * drift appears in neither.
 */
export function collectClassNameEdits(
  pages: readonly Page[],
  styleRules: Record<string, StyleRule>,
  visualComponents: SiteDocument['visualComponents'],
): ClassNameEditPlan {
  const edits: ClassNameEditPayload[] = []
  const unwritable: ClassAssignmentDriftDetail[] = []
  const tokenRefusals: ClassTokenRefusal[] = []
  const refusedNodeIds: string[] = []
  const pageIndex = buildClassPageIndex(pages)

  /** Plain class NAMES, for the honesty toast — which is about what the user sees, not what gets written. */
  const displayNames = (ids: readonly string[]): string[] =>
    ids.map((id) => styleRules[id]?.displayName ?? styleRules[id]?.name).filter((name): name is string => Boolean(name))

  for (const drift of collectClassIdsDrift(pages)) {
    if (drift.addedClassIds.length === 0 && drift.removedClassIds.length === 0) continue // reorder-only — nothing the cascade cares about

    const nodeLabel = getNodeDisplayName(drift.node, registry.get(drift.node.moduleId), visualComponents)

    if (!hasWritableSourceLocation(drift.nodeId)) {
      unwritable.push({
        nodeLabel,
        addedClassNames: displayNames(drift.addedClassIds),
        removedClassNames: displayNames(drift.removedClassIds),
        reordered: false,
      })
      continue
    }

    const add: ClassNameEditToken[] = []
    const remove: ClassNameEditToken[] = []
    let refused = false
    for (const [ids, into] of [
      [drift.addedClassIds, add],
      [drift.removedClassIds, remove],
    ] as const) {
      for (const classId of ids) {
        const resolved = resolveClassToken(classId, styleRules, pageIndex)
        if (!resolved) continue
        if (!resolved.ok) {
          tokenRefusals.push({
            nodeLabel,
            className: styleRules[classId]?.displayName ?? styleRules[classId]?.name ?? classId,
            reason: resolved.reason,
            message: resolved.message,
          })
          refused = true
          continue
        }
        into.push(resolved.token)
      }
    }

    // A partially-resolvable drift is held back WHOLE. Sending half of it
    // would advance the baseline past the other half on the caller's side,
    // and one element carrying an add without its paired remove is a worse
    // intermediate state than one more save tick.
    if (refused) {
      refusedNodeIds.push(drift.nodeId)
      continue
    }
    if (add.length === 0 && remove.length === 0) continue

    edits.push({ kind: 'class', nodeId: drift.nodeId, add, remove })
  }

  return { edits, unwritable, tokenRefusals, refusedNodeIds }
}
