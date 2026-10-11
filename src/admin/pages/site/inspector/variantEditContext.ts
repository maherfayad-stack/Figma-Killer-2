/**
 * variantEditContext — the inspector's half of the VARIANT EDIT CONTEXT (CV-4,
 * the rule is `@core/component-variants`'s `variantStyleContext.ts`).
 *
 * A style edit made on an element that sits inside a component is a
 * shared-component edit. Without a context it lands in whatever the cascade
 * says wins, which for a colour only `.btn` sets is the base rule — so a person
 * looking at the ghost button changes every variant. With one, the edit is
 * aimed at the rule of the variant they are looking at (`.btn-ghost`), written
 * through the same style ladder as any class edit, or refused by name.
 *
 * ## When it is active
 *
 *   - the selection is ONE element inlined out of a component (its id has a
 *     `~` tail), and
 *   - the person is editing the MAIN component — the variants gallery on the
 *     Components board always is; anywhere else it is "Edit main component"
 *     (`mainEditComponent`) — and
 *   - the component's variant props style THAT element (the binding's
 *     `element` is the selected node's own tail). An inner icon or wrapper has
 *     no variant rule of its own and keeps the ordinary behaviour.
 *
 * Outside those, nothing here runs: the catalog is not even fetched.
 *
 * Which variant the element is shown with comes from the call site that
 * produced it (`callSiteProps`, falling back to the component's declared
 * default). A prop the call site computes in code still has the value the
 * parser resolved, so it still has a rule to edit.
 */
import {
  deriveVariantStyleContext,
  isGalleryPage,
  type VariantAxisInput,
  type VariantStyleContext,
  type VariantStyleRule,
} from '@core/component-variants'
import { decodeSourceNodeId, INLINE_ID_SEPARATOR, isInlinedNodeId, type StyleRule } from '@core/page-tree'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { findLocalComponentSpec, useLocalComponentCatalog } from '@site/studio/componentCatalog'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { WriteTarget } from './resolveWriteTarget'

/** What the call site that inlined a component says about it. */
export interface CallSiteInstance {
  componentName: string
  sourceFile: string
  callSiteProps: Readonly<Record<string, unknown>>
}

/** The id of the call site an inlined node was expanded from: everything before the LAST `~`. */
export function callSiteIdOf(nodeId: string): string | null {
  const cut = nodeId.lastIndexOf(INLINE_ID_SEPARATOR)
  return cut < 0 ? null : nodeId.slice(0, cut)
}

/** The member a variant prop shows: the call site's value, else the declared default; a boolean that is on is `'true'`. */
function shownMember(value: unknown, fallback: unknown): string | undefined {
  const pick = value ?? fallback
  if (typeof pick === 'string') return pick
  if (pick === true) return 'true'
  if (typeof pick === 'number') return String(pick)
  return undefined
}

/**
 * The context for one selected, inlined element — pure, so the rule it applies
 * is testable without a store. `null` when no variant prop styles the element.
 */
export function resolveVariantEditContext(params: {
  nodeId: string
  callSite: CallSiteInstance
  catalog: readonly LocalComponentSpec[]
  chosenAxis: string | null
}): VariantStyleContext | null {
  const { nodeId, callSite, catalog, chosenAxis } = params
  const tail = decodeSourceNodeId(nodeId)
  if (!tail || tail.rel !== callSite.sourceFile) return null
  const spec = findLocalComponentSpec(catalog, callSite.componentName, callSite.sourceFile)
  if (!spec || spec.file !== tail.rel) return null
  const axes: VariantAxisInput[] = spec.props
    .filter((prop) => prop.binding !== undefined)
    .map((prop) => ({ prop: prop.name, member: shownMember(callSite.callSiteProps[prop.name], prop.defaultValue), binding: prop.binding }))
  return deriveVariantStyleContext({ line: tail.line, column: tail.col }, axes, chosenAxis)
}

/** Collapses whitespace and quote style: a selector as postcss wrote it and as the CSSOM serialised it name the same rule. */
function selectorKey(selector: string): string {
  return selector.replace(/\s+/g, ' ').replace(/'/g, '"').trim()
}

/** The `StyleRule.id` whose write-back source is this (file, selector) — the rule a variant context points at. */
export function findStyleRuleIdForSource(
  sources: Readonly<Record<string, { file: string; selector: string }>>,
  target: { file: string; selector: string },
): string | null {
  const wanted = selectorKey(target.selector)
  for (const [id, source] of Object.entries(sources)) {
    if (source.file !== target.file) continue
    if (selectorKey(source.selector) === wanted) return id
    if (source.selector.split(',').some((part) => selectorKey(part) === wanted)) return id
  }
  return null
}

/**
 * The variant edit context for the current single selection, or `null`.
 * Every early exit happens before the catalog is requested.
 */
export function useVariantEditContext(selectedNodeId: string | null, fromComponent: string | undefined, isMultiSelect: boolean): VariantStyleContext | null {
  const inlined = !isMultiSelect && selectedNodeId !== null && fromComponent !== undefined && isInlinedNodeId(selectedNodeId)
  const editingMain = useEditorStore((s) => s.mainEditComponent !== null && s.mainEditComponent === fromComponent)
  const inGallery = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page !== null && isGalleryPage(page)
  })
  const chosenAxis = useEditorStore((s) => s.variantEditAxis)
  const active = inlined && (editingMain || inGallery)
  const activeNodeId = active ? selectedNodeId : null
  const callSiteProps = useEditorStore((s) => {
    if (activeNodeId === null) return null
    const id = callSiteIdOf(activeNodeId)
    return id === null ? null : (selectActiveCanvasPage(s)?.nodes[id]?.props ?? null)
  })
  const catalog = useLocalComponentCatalog(active)
  if (activeNodeId === null || catalog === null || callSiteProps === null) return null
  const sourceFile = callSiteProps.sourceFile
  const componentName = callSiteProps.componentName
  const values = callSiteProps.callSiteProps
  if (typeof sourceFile !== 'string' || typeof componentName !== 'string') return null
  return resolveVariantEditContext({
    nodeId: activeNodeId,
    callSite: { componentName, sourceFile, callSiteProps: typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {} },
    catalog,
    chosenAxis,
  })
}

/**
 * Why the rule a variant context points at cannot take a write, or `null` when
 * it can: it is not one of the rules the board loaded (a stylesheet Studio does
 * not read as plain CSS), or the class is one Studio does not write.
 */
export function variantRuleBlocker(chosen: VariantStyleRule, rule: StyleRule | null, lockReason: string | null): string | null {
  if (rule === null) {
    return `${chosen.selector} in ${chosen.file} is not one of the rules this board loaded, so an edit cannot be sent to ${chosen.prop === chosen.member ? chosen.prop : `${chosen.prop} ${chosen.member}`}. Reload the board and try again.`
  }
  return lockReason
}

/**
 * The write target for ONE property while a variant edit context is active:
 * the chosen member's rule, or no target and the reason. It never falls back
 * to the element's other classes or its inline layer — that fallback is the
 * leak this context exists to close.
 */
export function variantWriteTarget(params: {
  context: VariantStyleContext
  /** The `StyleRule` the chosen rule maps to; `null` when none of the loaded rules has that source. */
  rule: StyleRule | null
  /** `variantRuleBlocker`'s answer for that rule. */
  blocker: string | null
  property: string
  /** Clearing a declaration: there is something to remove only if the member's rule declares it. */
  existing: boolean
  activeContextId: string | null
}): WriteTarget {
  const { context, rule, blocker, property, existing, activeContextId } = params
  const chosen = context.chosen
  if (chosen.kind === 'refused') return { kind: 'none', reason: `${chosen.message} ${chosen.remedy}` }
  if (rule === null || blocker !== null) return { kind: 'none', reason: blocker ?? `${chosen.selector} is not loaded.` }
  if (existing) {
    const declared = activeContextId === null ? rule.styles : (rule.contextStyles[activeContextId] ?? {})
    if (!(property in declared)) return { kind: 'none', reason: `${chosen.selector} does not set ${property}.` }
  }
  return { kind: 'class', classId: rule.id, selector: chosen.selector }
}
