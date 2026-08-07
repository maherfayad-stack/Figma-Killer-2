/**
 * extractSubtreeToComponent — E2.1, the foundation of the "page-as-component
 * with slots" flagship (`STUDIO-FIGMA-PARITY-PLAN.md` §8, Track E). Takes a
 * selected JSX subtree and emits a real, hand-writable component FILE plus a
 * rewritten call site — the reverse of `detachComponent.ts`'s "inline a
 * component here" verb: this one PULLS a subtree OUT into its own component.
 *
 * THE GOVERNING PRINCIPLE (see `STUDIO-FIGMA-PARITY-PLAN.md` §8's E2
 * preamble): the user's own `.tsx` is the only representation. No `.studio/`
 * sidecar remembers what a prop is bound to — the new file's own `interface`
 * does, and the parser reads it back the next time this project loads. This
 * is why the CMS Visual Component system (nanoid ids, DB rows, a
 * `propBindings` map) is the wrong SUBSTRATE for this feature even though its
 * interaction model (outlet paired to fill, by name) is exactly right to
 * copy — see the plan doc for the full argument. Nothing here touches
 * `@core/visualComponents`.
 *
 * THE MODEL — the subtree's own JSX text is NEVER rewritten
 * -----------------------------------------------------------
 * The whole subtree moves into the new file byte-for-byte (`subtreeText`
 * below, `root.getText()`). A reference inside it — `{user.name}`,
 * `{cond ? a : b}`, a template literal — is written to the new file EXACTLY
 * as it stood in the page, because nothing about how it is written changes:
 * only which SCOPE now provides `user`/`cond`/`a`/`b` changes. That scope
 * question is `subtreeFreeVariables.ts`'s `analyzeFreeVariables` — see its
 * own module doc for the full partition rule (module-scope name -> mirrored
 * import; body-local name -> prop) and for why "hooks move with the
 * subtree" holds in this direction but not for `detachComponent.ts`'s.
 *
 * At the CALL SITE, each prop is forwarded as `name={name}` — the BINDING,
 * never a baked value. This is trap #4 (`PROJECT-BRIEF.md` §6): `{user.name}`
 * evaluates to `"Ada"` on the canvas, and writing THAT back would delete the
 * binding forever. Forwarding the plain identifier is what keeps this
 * honest, and it is the only shape a forwarded prop ever takes here — there
 * is no "evaluated value" code path in this file at all to accidentally
 * reach.
 *
 * LOCATE, THEN REFUSE FIRST — before any free-variable analysis runs
 * --------------------------------------------------------------------
 * Seven reasons, in the order checked:
 *
 *   1-4. `list-row` / `shared-component` / `route-chrome` / `code-placed` —
 *        `refusePlacement` (`@core/page-tree`, lifted out of
 *        `sourceStructure.ts` for exactly this reuse — see that function's
 *        own doc comment, now a published contract for D2/F2 too). Pure and
 *        string-based: it needs the subtree's studio node id and the
 *        parser's own `lockReason`, which only a caller holding the loaded
 *        page tree has — pass them through `params.nodeId`/`params.lockReason`
 *        when available (the store, an MCP tool backed by a parse, a server
 *        handler). Without them this function still gets `route-chrome` for
 *        free (filename-derivable) and an AST-only `list-row` safety net
 *        below; it does NOT independently derive `shared-component` or
 *        `code-placed` — those need information only a parse carries, the
 *        same layering `struct-01` established for reorder/delete (asked at
 *        the STORE, re-derived only in RESIDUAL form by the codemod itself).
 *   5. `spread-props` — an element in the subtree spreads an arbitrary prop
 *      bag (`{...rest}`). This codemod can't enumerate what a spread
 *      contains, so the new component's `interface` would be asserting a
 *      shape the user never chose (§2's invariant) — refuse rather than
 *      guess at a prop list.
 *   6. `name-taken` — the chosen component name collides with the new
 *      file's own path, a binding already in scope in the page file, or
 *      (Track E1's catalog) an existing component elsewhere in the project.
 *      Checked last because it is the only one that touches the filesystem
 *      and (in the fallback path) scans the whole workspace `Project`.
 *   7. `slot-name-conflict` (E2.2) — two `slotChildren` decisions name the
 *      same slot, or a slot name collides with a forwarded free-variable
 *      prop of the same name. Checked twice, at the only two points either
 *      collision becomes knowable: once against each other right after
 *      `slotChildren` is validated, and again against `propVariables` once
 *      free-variable analysis has run.
 *
 * E2.2 — THE KEEP/SLOT TOGGLE
 * -----------------------------
 * `params.slotChildren` names zero or more of `root`'s own direct, markup-
 * bearing children (`subtreeSlotChildren.ts`'s `listSlotChildCandidates`) to
 * pull OUT of the new file and forward from the call site instead of moving
 * them inline. A slotted child's own JSX text is never rewritten either —
 * same "moved verbatim" rule as the rest of this module — it just changes
 * WHICH SIDE of the extraction boundary it sits on: in the new file its
 * position becomes `{slotName}`; at the call site it becomes that child's own
 * text, verbatim, either as `slotName={<Original/>}` (a named slot) or as the
 * new element's own JSX children (the conventional `'children'` slot — see
 * `subtreeSlotChildren.ts`'s naming doc). Because a slotted child's text
 * never leaves the page file, none of ITS OWN free variables need mirroring
 * into the new file — `analyzeFreeVariables`'s `excluded` param leaves them
 * out of that analysis entirely (they already resolve wherever they always
 * did). An empty/omitted `slotChildren` produces BYTE-IDENTICAL output to
 * E2.1's original behaviour — verified by test.
 *
 * `shifted: true` on success — an extraction moves lines in the page file
 * (the subtree is replaced by a shorter call-site element) exactly like a
 * structural move/delete, so every downstream `line:col` id below it is
 * stale; the caller must reload.
 */
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { Node, Project, QuoteKind, SyntaxKind, type SourceFile } from 'ts-morph'
import { LOOP_ID_SEPARATOR, refusePlacement, type StructuralRefusalReason } from '@core/page-tree'
import { createWorkspaceProject } from '@core/page-parser'
import { findJsxElementAtLocationOrThrow, loadSourceFile, resolveJsxWholeElement } from './locateJsxElement'
import { addReconciledImports, relativeSpecifier, removeImportIfLastUsage, topLevelBindingNames } from './importReconcile'
import { analyzeFreeVariables, type FreeVariable } from './subtreeFreeVariables'
import { collectSlotChildCandidates } from './subtreeSlotChildren'

export interface ExtractSubtreeToComponentParams {
  /** Absolute path to the page file holding the subtree's root element. */
  file: string
  /** 1-based line/col of the root element's tag-name start (this module's usual location convention — see `locateJsxElement.ts`). */
  line: number
  col: number
  workspaceRoot: string
  /** The new component's name — must already be a valid PascalCase identifier; the caller (the picker UI) owns prompting for it. */
  componentName: string
  /**
   * The subtree root's own studio node id, when the caller already has one —
   * the loaded page tree always does. Passed to `refusePlacement` FIRST, so
   * a `.map` row, an inlined (shared-component) node, route chrome, or a
   * parser-recorded structural lock refuses before any analysis runs. See
   * this module's own doc for what still gets checked when this is omitted.
   */
  nodeId?: string
  /** The subtree root's own structural lock reason, mirroring `ParsedNode.lockReason`, when the caller has one. */
  lockReason?: string
  /**
   * Names already known to collide — e.g. `GET /admin/api/studio/components`'s
   * `LocalComponentSpec[]` catalog (`server/handlers/studio/componentSpecExtract.ts`,
   * Track E1), the caller's more authoritative source. When omitted, this
   * codemod falls back to its own lighter, existence-only scan of the same
   * workspace `Project` — see `workspaceHasComponentNamed` below.
   */
  existingComponentNames?: ReadonlySet<string>
  /**
   * E2.2's keep/slot toggle. Each entry names one of `root`'s own slottable
   * direct children (`childIndex` — see `subtreeSlotChildren.ts`'s
   * `listSlotChildCandidates`, the ONLY sanctioned source of a valid index)
   * to pull out of the new file and forward from the call site instead.
   * Omitted/empty means every child stays inline — E2.1's original,
   * unchanged behaviour, byte-identical (verified by test). See this
   * module's own doc, "E2.2 — THE KEEP/SLOT TOGGLE", for the full model.
   */
  slotChildren?: SlotChildDecision[]
  project?: Project
}

/**
 * One keep/slot decision (E2.2). `childIndex` must be one of the indices
 * `subtreeSlotChildren.ts`'s `listSlotChildCandidates` actually returned for
 * this exact (file, line, col) — an out-of-range or duplicate index is a
 * CALLER-CONTRACT violation (this function throws, same trust level as
 * `componentName`'s PascalCase check), not a refusal a user needs explained.
 * `slotName` is never invented here — the caller already showed a derived
 * default for correction (`subtreeSlotChildren.ts`'s `suggestSlotNames`)
 * before submitting; an invalid identifier also throws, while a NAME
 * COLLISION between two decisions (or against a forwarded prop) is a real,
 * correctable mistake and refuses `slot-name-conflict` instead.
 */
export interface SlotChildDecision {
  childIndex: number
  slotName: string
}

/**
 * The full refusal vocabulary. Four reasons (`list-row`, `shared-component`,
 * `route-chrome`, `code-placed`) are `StructuralRefusalReason`'s own —
 * reused, not reinvented, per this module's own doc — even though this
 * codemod only ever RETURNS that subset of the wider type (a reorder/delete/
 * insert-only reason like `multi-select` can never come out of
 * `refusePlacement`, which this file is the only caller of here). Three
 * reasons are genuinely new here: `spread-props`, `name-taken`, and (E2.2)
 * `slot-name-conflict`.
 */
export type ExtractSubtreeRefusalReason = StructuralRefusalReason | 'spread-props' | 'name-taken' | 'slot-name-conflict'

export interface ExtractSubtreeRefusal {
  reason: ExtractSubtreeRefusalReason
  message: string
}

export interface ExtractSubtreeToComponentSuccess {
  ok: true
  /** Workspace-relative POSIX path of the new component file. */
  newFile: string
  componentName: string
  /**
   * The full free-variable partition this extraction inferred — shown for
   * correction, never silently applied blind: this is the ONLY record of
   * which names became mirrored imports vs. props, and a caller offering a
   * review step (rename a prop, fix a mis-typed `ComponentType` guess) reads
   * it from here. `extractSubtreeToComponent` does not itself pause for
   * review — see this module's own "integration gap" note in the E2.1
   * handoff for who owns that surface.
   */
  freeVariables: FreeVariable[]
  /**
   * Every slot this extraction actually created (E2.2), in the same order as
   * `params.slotChildren` — empty when none were requested. Reported for the
   * same "shown after the fact, since this codemod already committed" reason
   * `freeVariables` is: a caller offering a review step reads it from here.
   */
  slots: { slotName: string }[]
  /** Always `true` — an extraction always shifts line numbers in the page file. */
  shifted: true
}

export interface ExtractSubtreeToComponentFailure {
  ok: false
  refusal: ExtractSubtreeRefusal
}

export type ExtractSubtreeToComponentResult = ExtractSubtreeToComponentSuccess | ExtractSubtreeToComponentFailure

function refuse(reason: ExtractSubtreeRefusalReason, message: string): ExtractSubtreeToComponentFailure {
  return { ok: false, refusal: { reason, message } }
}

const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/
const SLOT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** True when `node` sits entirely within one of `ranges` — the spread-props check's E2.2 exclusion. */
function isWithinAnyRange(node: Node, ranges: readonly { start: number; end: number }[]): boolean {
  const start = node.getStart()
  const end = node.getEnd()
  return ranges.some((r) => start >= r.start && end <= r.end)
}

/** The first value that appears more than once in `values`, or `undefined` if every value is unique. */
function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return undefined
}

/**
 * `root`'s own text with each slotted child's text range replaced by
 * `{slotName}` — this is what makes the new file's markup reference the
 * slot instead of the child's own content, while everything else in `root`
 * moves byte-for-byte (this module's usual "never rewritten" rule; see the
 * class doc's "E2.2" section). Replaces from the LAST slot backward so
 * earlier offsets stay valid as later ones shrink the text.
 */
function buildTemplateText(root: Node, resolvedSlots: readonly { node: Node; slotName: string }[]): string {
  const rootStart = root.getStart()
  let text = root.getText()
  const bySourceOrder = [...resolvedSlots].sort((a, b) => b.node.getStart() - a.node.getStart())
  for (const { node, slotName } of bySourceOrder) {
    const start = node.getStart() - rootStart
    const end = node.getEnd() - rootStart
    text = `${text.slice(0, start)}{${slotName}}${text.slice(end)}`
  }
  return text
}

/**
 * AST-only `list-row` safety net, independent of `params.nodeId`: `root`
 * sits inside a `.map()` callback, so one piece of source JSX renders every
 * row regardless of whether the caller told us so. Reuses `refusePlacement`
 * itself (via a synthetic id shaped like a real loop-iteration one,
 * `LOOP_ID_SEPARATOR`) rather than hand-writing the `list-row` message a
 * second time — see this module's own doc for why this matters.
 */
function isInsideMapCallback(node: Node): boolean {
  for (const ancestor of node.getAncestors()) {
    if (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor)) continue
    const call = ancestor.getParent()
    if (!Node.isCallExpression(call)) continue
    const callee = call.getExpression()
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'map') return true
  }
  return false
}

/**
 * Lightweight, EXISTENCE-only sibling of
 * `server/handlers/studio/componentSpecExtract.ts`'s catalog builder — that
 * module lives under `server/handlers` and `src/core/ast-codemods` (a
 * `src/core` module) must not depend on it (core is not allowed to depend on
 * the server layer — a layering rule, not a convenience). It cannot answer
 * "what props does this take" the way the real catalog can; it only answers
 * "does a component already exist under this exact name anywhere in the
 * project", which is all `name-taken` needs. A caller that already ran the
 * real catalog should pass its names via `existingComponentNames` instead —
 * see this module's own doc.
 */
function workspaceHasComponentNamed(project: Project, name: string): boolean {
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.getFunction(name)) return true
    if (sourceFile.getClass(name)) return true
    if (sourceFile.getVariableDeclaration(name)) return true
  }
  return false
}

function nameTakenMessage(
  project: Project,
  pageFile: SourceFile,
  newPath: string,
  componentName: string,
  existingComponentNames: ReadonlySet<string> | undefined,
): string | undefined {
  if (existsSync(newPath)) {
    return `${path.basename(newPath)} already exists next to ${path.basename(pageFile.getFilePath())} — pick a different name.`
  }
  if (topLevelBindingNames(pageFile).has(componentName)) {
    return `"${componentName}" is already used by an import or declaration in ${path.basename(pageFile.getFilePath())} — pick a different name.`
  }
  const taken = existingComponentNames ? existingComponentNames.has(componentName) : workspaceHasComponentNamed(project, componentName)
  if (taken) return `A component named "${componentName}" already exists in this project — pick a different name.`
  return undefined
}

/**
 * Extracts the JSX subtree rooted at (file, line, col) into a new component
 * file named `params.componentName`, next to the page file, and rewrites the
 * call site to `<ComponentName prop={prop} …/>`. See this module's own doc
 * for the refusal order and the free-variable model.
 */
export function extractSubtreeToComponent(params: ExtractSubtreeToComponentParams): ExtractSubtreeToComponentResult {
  const { file, line, col, workspaceRoot, componentName } = params
  if (!COMPONENT_NAME_RE.test(componentName)) {
    // A caller-contract violation, not a legitimate refusal a user needs
    // explained — the picker UI is responsible for only ever offering a
    // valid PascalCase name, the same trust level `findJsxElementAtLocationOrThrow`
    // extends to its own (file, line, col) inputs.
    throw new Error(`extractSubtreeToComponent: "${componentName}" is not a valid component name (must start with an uppercase letter).`)
  }

  const project = params.project ?? createWorkspaceProject(workspaceRoot)
  // New import declarations synthesized below follow ts-morph's own
  // quote-kind setting rather than the file's existing style — see
  // `detachComponent.ts`'s identical setting for why (new declarations, not
  // an existing literal edited in place, so there is no "the file's own
  // style" to match textually).
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const pageFile = loadSourceFile(project, file)

  const opening = findJsxElementAtLocationOrThrow(pageFile, file, line, col)
  // A self-closing element's `.getParent()` is whatever CONTAINS it, not
  // "this element's own open+close pair" — same distinction
  // `detachComponent.ts`/`swapComponentInstance.ts` document identically.
  const { root } = resolveJsxWholeElement(opening)

  const relFile = path.relative(workspaceRoot, file).split(path.sep).join('/')
  const effectiveNodeId = params.nodeId ?? `${relFile}:${line}:${col}`

  // Refuse FIRST — reasons 1-4, the vocabulary the user already sees on a
  // failed move/delete.
  const placementRefusal = refusePlacement({ id: effectiveNodeId, lockReason: params.lockReason }, 'Extracted')
  if (placementRefusal) return refuse(placementRefusal.reason, placementRefusal.message)

  if (isInsideMapCallback(root)) {
    const asLoopRow = refusePlacement({ id: `${effectiveNodeId}${LOOP_ID_SEPARATOR}0` }, 'Extracted')
    if (asLoopRow) return refuse(asLoopRow.reason, asLoopRow.message)
  }

  // E2.2 — resolve `params.slotChildren` against `root`'s actual slottable
  // children. Every failure here is a CALLER-CONTRACT violation (a stale or
  // hand-rolled index/duplicate), not a user-facing refusal — see
  // `SlotChildDecision`'s own doc for why this trusts the caller the same
  // way `componentName`'s format check does.
  const candidates = collectSlotChildCandidates(root)
  const seenChildIndex = new Set<number>()
  const resolvedSlots: { node: Node; slotName: string }[] = []
  for (const decision of params.slotChildren ?? []) {
    const match = candidates.find((c) => c.candidate.index === decision.childIndex)
    if (!match) {
      throw new Error(
        `extractSubtreeToComponent: slotChildren refers to childIndex ${decision.childIndex}, which is not one of this subtree's slottable direct children (see subtreeSlotChildren.ts's listSlotChildCandidates).`,
      )
    }
    if (seenChildIndex.has(decision.childIndex)) {
      throw new Error(`extractSubtreeToComponent: slotChildren names childIndex ${decision.childIndex} more than once.`)
    }
    seenChildIndex.add(decision.childIndex)
    if (!SLOT_NAME_RE.test(decision.slotName)) {
      throw new Error(`extractSubtreeToComponent: "${decision.slotName}" is not a valid prop name for a slot.`)
    }
    resolvedSlots.push({ node: match.node, slotName: decision.slotName })
  }

  // Reason 5 — spread-props, EXCLUDING anything inside a SLOTTED child: that
  // markup never enters the new file's interface at all (it stays in the
  // page file, just relocated to the call site), so a spread inside it is no
  // more this codemod's concern than a spread anywhere else in the page.
  const slottedRanges = resolvedSlots.map(({ node }) => ({ start: node.getStart(), end: node.getEnd() }))
  const spreadsInKeptContent = root
    .getDescendantsOfKind(SyntaxKind.JsxSpreadAttribute)
    .filter((spread) => !isWithinAnyRange(spread, slottedRanges))
  if (spreadsInKeptContent.length > 0) {
    return refuse(
      'spread-props',
      "This element spreads an arbitrary prop bag ({...props}) — Studio can't read what it contains, so the new component's interface would be asserting a shape you didn't choose. Replace the spread with explicit props first.",
    )
  }

  const dir = path.dirname(file)
  const newPath = path.join(dir, `${componentName}.tsx`)

  // Reason 6.
  const nameTaken = nameTakenMessage(project, pageFile, newPath, componentName, params.existingComponentNames)
  if (nameTaken) return refuse('name-taken', nameTaken)

  // Reason 7a — two slot decisions naming the same slot.
  const duplicateSlotName = findDuplicate(resolvedSlots.map((s) => s.slotName))
  if (duplicateSlotName) {
    return refuse('slot-name-conflict', `Two selected children both want the slot name "${duplicateSlotName}" — give each a distinct name.`)
  }

  // --- Analysis — no writes yet -----------------------------------------
  // A slotted child's own free variables are excluded: its text never moves
  // into the new file (see this module's own "E2.2" doc section), so nothing
  // inside it needs a mirrored import or a forwarded prop.
  const freeVariables = analyzeFreeVariables(root, pageFile, resolvedSlots.map((s) => s.node))
  const moduleScopeNames = new Set(freeVariables.filter((v) => v.kind === 'import').map((v) => v.name))
  const propVariables = freeVariables.filter((v) => v.kind === 'prop')

  // Reason 7b — a slot name colliding with a forwarded prop of the same name
  // (only knowable once free-variable analysis has run).
  const propNames = new Set(propVariables.map((v) => v.name))
  const slotVsProp = resolvedSlots.find((s) => propNames.has(s.slotName))
  if (slotVsProp) {
    return refuse(
      'slot-name-conflict',
      `The slot name "${slotVsProp.slotName}" collides with a forwarded prop of the same name — rename one.`,
    )
  }

  const subtreeText = buildTemplateText(root, resolvedSlots)

  // --- Emit the new component file --------------------------------------
  const newSourceFile = project.createSourceFile(newPath, '', { overwrite: false })
  addReconciledImports(newSourceFile, pageFile, moduleScopeNames)

  const needsComponentType = propVariables.some((v) => v.isComponentTag)
  if (needsComponentType) {
    newSourceFile.addImportDeclaration({ moduleSpecifier: 'react', namedImports: ['ComponentType'], isTypeOnly: true })
  }
  if (resolvedSlots.length > 0) {
    newSourceFile.addImportDeclaration({ moduleSpecifier: 'react', namedImports: ['ReactNode'], isTypeOnly: true })
  }

  // No props/slots at all -> no interface and no parameter, the same shape a
  // human would hand-write for a component that takes nothing. An empty
  // `interface {}` plus an unused `_props` parameter would be exactly the
  // kind of tool-shaped noise `extractSubtreeToComponent`'s own contract
  // ("a human opening the file must not be able to tell a tool wrote it")
  // rules out.
  const propsInterfaceName = `${componentName}Props`
  const parameters: { name: string }[] = []
  const interfaceProperties = [
    ...propVariables.map((v) => ({ name: v.name, type: v.isComponentTag ? 'ComponentType' : 'unknown' })),
    // E2.2 slot props are REQUIRED, not optional — unlike `addSlotPropToComponent`'s,
    // which must stay valid at N EXISTING call sites this codemod never
    // touches, this one always rewrites its own single call site to pass
    // every slot it created, so there is no untouched call site to protect.
    ...resolvedSlots.map((s) => ({ name: s.slotName, type: 'ReactNode' })),
  ]
  if (interfaceProperties.length > 0) {
    newSourceFile.addInterface({ isExported: true, name: propsInterfaceName, properties: interfaceProperties })
    const paramNames = [...propVariables.map((v) => v.name), ...resolvedSlots.map((s) => s.slotName)]
    parameters.push({ name: `{ ${paramNames.join(', ')} }: ${propsInterfaceName}` })
  }

  newSourceFile.addFunction({
    isExported: true,
    name: componentName,
    parameters,
    statements: `return (\n${subtreeText}\n)`,
  })
  newSourceFile.saveSync()

  // --- Rewrite the call site ---------------------------------------------
  // Every prop is forwarded as `name={name}` — the binding, never a baked
  // value (trap #4; see this module's own doc). A NAMED slot is forwarded as
  // `slotName={<Original/>}` — the slotted child's own text, verbatim (never
  // re-evaluated) — and the conventional `'children'` slot becomes the new
  // element's own JSX children instead of an attribute, so the call site is
  // only self-closing when there is no `'children'` slot decision.
  const childrenSlot = resolvedSlots.find((s) => s.slotName === 'children')
  const namedSlotAttrs = resolvedSlots.filter((s) => s.slotName !== 'children').map((s) => `${s.slotName}={${s.node.getText()}}`)
  const attrsText = [...propVariables.map((v) => `${v.name}={${v.name}}`), ...namedSlotAttrs].join(' ')
  const openTag = `<${componentName}${attrsText ? ` ${attrsText}` : ''}`
  const newElementText = childrenSlot ? `${openTag}>${childrenSlot.node.getText()}</${componentName}>` : `${openTag} />`

  root.replaceWithText(newElementText)

  pageFile.addImportDeclaration({ moduleSpecifier: relativeSpecifier(file, newPath), namedImports: [componentName] })

  // Only now — after the call site's own reference to each module-scope name
  // is actually gone from the tree — is "does anything else in the page
  // still reference it" decidable. Same ordering `detachComponent.ts` uses
  // for its own `Card` import removal, for the identical reason.
  for (const name of moduleScopeNames) removeImportIfLastUsage(pageFile, name)

  pageFile.saveSync()

  return {
    ok: true,
    newFile: path.relative(workspaceRoot, newPath).split(path.sep).join('/'),
    componentName,
    freeVariables,
    slots: resolvedSlots.map((s) => ({ slotName: s.slotName })),
    shifted: true,
  }
}
