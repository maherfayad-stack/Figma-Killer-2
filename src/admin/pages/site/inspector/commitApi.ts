/**
 * commitApi — the "one commit API" `STUDIO-LIVE-CANVAS-PLAN.md` §P4 names,
 * collapsing every style/prop write in the single-selection path onto
 * `commitStyle`/`commitStyleMany`/`commitProp`/`clearStylePreview`.
 *
 * This is plumbing, not a new write primitive: every branch below dispatches
 * to the SAME store actions `WriteTargetStyleComposer.tsx` already called
 * (`setNodeInlineStyles`, `updateClassStyles`, `setClassContextStyles`,
 * `removeClassStyleProperty`/`clearClassStyleProperties`,
 * `setPreviewNodeStyles`/`clearPreviewNodeStyles`,
 * `setPreviewClassStyles`/`clearPreviewClassStyles`, `updateNodeProps`,
 * `setBreakpointOverride`) — those remain the one-honest-write-target
 * primitives. What this file replaces is every OTHER place that called
 * `writeTargetFor`/`resolveWriteTarget` itself and then picked the store
 * action inline — today, after the Step 0 merge, that is
 * `WriteTargetStyleComposer.tsx` alone (`InlineStyleComposer.tsx` is
 * confirmed dead code post-merge, see `STATE.md` `panel-23` Phase B item 4).
 *
 * ## `commitStyle` vs `commitStyleMany`
 *
 * `commitStyle` is `commitStyleMany` with a one-key patch — there is no
 * separate single-property code path, so the two can never drift. Passing
 * `value: null` reproduces `WriteTargetStyleComposer.tsx`'s old `onRemove`
 * exactly (a single-context null-set via `updateClassStyles`/
 * `setClassContextStyles`/inline — NOT a cross-context purge).
 *
 * ## `mode: 'set' | 'clear'`
 *
 * `StyleSectionsEditor.tsx`'s own doc comment on `onChangeMany` states the
 * exact distinction this preserves: `onChangeMany` (`mode: 'set'`, the
 * default) commits to the SINGLE active context (base, or the active
 * breakpoint/condition override). `onClearProperties` (`mode: 'clear'`) is a
 * CROSS-CONTEXT purge — every property removed from base AND every
 * breakpoint/condition override in one call, via `clearClassStyleProperties`
 * for a class target (inline has no context axis, so `clear` and `set null`
 * are the same operation there). `mode: 'clear'` resolves its target via
 * `resolveExistingWriteTarget` by default (there is nothing to "clear" that
 * doesn't already have an honest source) unless the caller explicitly
 * overrides `existing`.
 *
 * ## Locked (code-valued) properties — refuse the WHOLE key, not half
 *
 * A `style:<prop>` entry in `selectedNode.codeProps` is resolved from an
 * expression in code. `WriteTargetStyleComposer.tsx`'s handlers each
 * early-returned (single-key) or filtered the patch (multi-key) before ever
 * calling `writeTargetFor` for that property — a SEPARATE, stronger gate
 * than `SelectionModel.writeTargetFor`'s own `inlineWritableFor` (which only
 * blocks the INLINE branch of the P1 rule). This file preserves that same
 * two-layer behaviour verbatim: a locked key is dropped from the patch here,
 * before any target is resolved for it, so it is never routed to a class
 * target either. `setNodeInlineStyles`/`updateNodeProps`'s own all-or-nothing
 * refusal (any code-valued key in the SAME store-level call aborts the whole
 * patch) is a different, lower-level guard — this file never passes it a
 * mixed patch, so that guard is never the thing that fires here.
 *
 * ## N nodes (S5)
 *
 * `SelectionModel` now describes a multi-selection too, so this file is where
 * "one commit" stops meaning "one node". The only branch is the INLINE
 * target: `setNodesInlineStyles(ids, patch)` instead of
 * `setNodeInlineStyles(id, patch)`. It runs over `mutateTreesForNodeIds`, so a
 * selection spanning several board frames writes each frame's own page tree
 * inside ONE history transaction — an N-node edit is one Ctrl+Z, the same
 * contract `deleteNodes`/`wrapNodes` carry (`docs/features/inspector.md`
 * §9.1). The ids are `model.inlineWritableNodeIds`, not the raw selection: a
 * `pkg.*`/`studio.instance` node takes no inline write at all, and including
 * it would render on canvas and then be dropped at save.
 *
 * A CLASS target needs no branch — one class write already reaches every
 * element carrying the class, which is exactly why it is gated behind an
 * explicit blast-radius confirmation before the model will hand it over.
 *
 * `commitProp` stays single-selection. A module prop belongs to one call
 * site's schema; fanning one key across N nodes of possibly different modules
 * is not a Mixed collapse, it is a guess.
 */
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import type { CSSPropertyBag, PageNode } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { getActiveStyleTab } from '../panels/PropertiesPanel/classStyleSections'
import type { SelectionModel } from './selectionModel'
import type { WriteTarget } from './resolveWriteTarget'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CommitStyleOptions {
  preview?: boolean
  /** True for a remove/clear — routes through `resolveExistingWriteTarget` instead of `resolveWriteTarget`. */
  existing?: boolean
  /** Explicit override from a field's own popover menu — the per-field override P1 flagged as out of scope for `WriteTargetStyleComposer`; the hook exists even though no field UI calls it with an explicit target yet. */
  target?: WriteTarget
  /**
   * `'set'` (default) commits to the single active context. `'clear'` is a
   * cross-context purge (`clearClassStyleProperties`/inline-null-per-key) —
   * see this module's own doc. Only meaningful on `commitStyleMany`;
   * `commitStyle` always behaves as `'set'` (a single-context null-set for
   * `value: null`, matching the old `onRemove`, not a purge).
   */
  mode?: 'set' | 'clear'
}

export interface InspectorCommitApi {
  commitStyle(prop: keyof CSSPropertyBag, value: string | number | null, opts?: CommitStyleOptions): void
  /** Batches N properties into ONE history entry — replaces `StyleSectionsEditor`'s `onChangeMany`/`onClearProperties` call sites. */
  commitStyleMany(
    patch: Partial<Record<keyof CSSPropertyBag, string | number | null>>,
    opts?: Omit<CommitStyleOptions, 'target'>,
  ): void
  clearStylePreview(): void
  /**
   * Routes to `updateNodeProps`, or `setBreakpointOverride` when the active
   * breakpoint is non-default AND the module schema marks the prop
   * `breakpointOverridable` — the exact rule `usePropertiesPanelData.ts`'s
   * `handleChange` already implemented; moved here verbatim, not reinvented.
   */
  commitProp(key: string, value: unknown): void
}

// ---------------------------------------------------------------------------
// The code-lock rule, shared
// ---------------------------------------------------------------------------

/**
 * The style properties this node's own SOURCE computes — a `style:<prop>`
 * entry in `codeProps`. `commitStyleMany` drops every one of them from a patch
 * before a write target is even resolved (see this module's doc), so a control
 * that offers one commits nothing and says nothing.
 *
 * Exported because a surface OUTSIDE the inspector — the Assets panel's colour
 * swatches, which apply `var(--token)` to the selected layer's fill or text
 * through `commitStyle` — has to disable its own button on this exact rule
 * rather than let the user discover the refusal by nothing happening. One rule,
 * one implementation: this function is what the hook below uses too.
 */
export function lockedStyleProperties(node: PageNode | null): ReadonlySet<string> {
  return new Set(
    (node?.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )
}

// ---------------------------------------------------------------------------
// useInspectorCommit
// ---------------------------------------------------------------------------

export function useInspectorCommit(model: SelectionModel): InspectorCommitApi {
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const conditions = s.site?.conditions
    return conditions && conditions.some((c) => c.id === id) ? id : null
  })
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)
  const setNodesInlineStyles = useEditorStore((s) => s.setNodesInlineStyles)
  const updateClassStyles = useEditorStore((s) => s.updateClassStyles)
  const setClassContextStyles = useEditorStore((s) => s.setClassContextStyles)
  const clearClassStyleProperties = useEditorStore((s) => s.clearClassStyleProperties)
  const setPreviewClassStyles = useEditorStore((s) => s.setPreviewClassStyles)
  const clearPreviewClassStyles = useEditorStore((s) => s.clearPreviewClassStyles)
  const setPreviewNodeStyles = useEditorStore((s) => s.setPreviewNodeStyles)
  const clearPreviewNodeStyles = useEditorStore((s) => s.clearPreviewNodeStyles)
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const setBreakpointOverride = useEditorStore((s) => s.setBreakpointOverride)

  const {
    selectedNodeId,
    selectedNode,
    activeContextId,
    writeTargetFor,
    isMultiSelect,
    inlineWritableNodeIds,
  } = model

  /** The ids an inline write lands on — the whole writable selection, or the one node. */
  const inlineTargetIds = isMultiSelect
    ? inlineWritableNodeIds
    : selectedNodeId
      ? [selectedNodeId]
      : []

  const onCondition = activeConditionId !== null
  const activeTab = getActiveStyleTab(activeBreakpointId)

  const lockedPropertySet = lockedStyleProperties(selectedNode)

  const writeToTarget = (target: WriteTarget, patch: Record<string, string | number | null>) => {
    if (!selectedNodeId) return
    if (target.kind === 'inline') {
      if (inlineTargetIds.length === 0) return
      // One store action per cardinality, both sharing `applyInlineStylePatch`
      // so "clear this property" cannot mean two things.
      if (isMultiSelect) setNodesInlineStyles([...inlineTargetIds], patch)
      else setNodeInlineStyles(inlineTargetIds[0], patch)
    } else if (target.kind === 'class') {
      if (activeContextId) {
        setClassContextStyles(target.classId, activeContextId, patch as Partial<CSSPropertyBag>)
      } else {
        updateClassStyles(target.classId, patch as Partial<CSSPropertyBag>)
      }
    }
    // 'none' — no honest target; the row should already be disabled by the
    // caller when this is reachable, so this is a silent no-op rather than a
    // half-applied write.
  }

  const previewToTarget = (target: WriteTarget, patch: Partial<CSSPropertyBag>) => {
    if (target.kind === 'class') {
      // The class preview channel has no conditional-layer target — same
      // guard `WriteTargetStyleComposer.tsx`'s `handlePreview` used.
      if (onCondition) return
      setPreviewClassStyles({
        classId: target.classId,
        breakpointId: activeTab !== 'base' ? activeTab : null,
        styles: patch,
      })
    } else if (target.kind === 'inline') {
      if (inlineTargetIds.length === 0) return
      setPreviewNodeStyles({ nodeIds: [...inlineTargetIds], styles: patch })
    }
  }

  const clearToTarget = (target: WriteTarget, keys: string[]) => {
    if (target.kind === 'class') {
      clearClassStyleProperties(target.classId, keys as ReadonlyArray<keyof CSSPropertyBag>)
    } else if (target.kind === 'inline') {
      writeToTarget(target, Object.fromEntries(keys.map((k) => [k, null])))
    }
  }

  const commitStyleMany: InspectorCommitApi['commitStyleMany'] = (patch, opts) => {
    const keys = Object.keys(patch).filter((k) => !lockedPropertySet.has(k))
    if (keys.length === 0) return
    const mode = opts?.mode ?? 'set'
    const existing = opts?.existing ?? mode === 'clear'
    const target = writeTargetFor(keys[0], { existing })
    const filteredPatch: Record<string, string | number | null> = {}
    for (const key of keys) filteredPatch[key] = (patch as Record<string, string | number | null>)[key]

    if (opts?.preview) {
      previewToTarget(target, filteredPatch as Partial<CSSPropertyBag>)
      return
    }
    if (mode === 'clear') {
      clearToTarget(target, keys)
      return
    }
    writeToTarget(target, filteredPatch)
  }

  const commitStyle: InspectorCommitApi['commitStyle'] = (prop, value, opts) => {
    const key = String(prop)
    if (lockedPropertySet.has(key)) return
    const target = opts?.target ?? writeTargetFor(key, { existing: opts?.existing })
    if (opts?.preview) {
      previewToTarget(target, { [key]: value } as Partial<CSSPropertyBag>)
      return
    }
    writeToTarget(target, { [key]: value })
  }

  const clearStylePreview = () => {
    clearPreviewClassStyles()
    for (const id of inlineTargetIds) clearPreviewNodeStyles(id)
  }

  const moduleId = selectedNode?.moduleId
  const commitProp: InspectorCommitApi['commitProp'] = (key, value) => {
    // See this module's doc: a module prop has no honest N-node collapse.
    if (!selectedNodeId || isMultiSelect) return
    const def = moduleId ? registry.get(moduleId) : null
    const isOverridable = def?.schema[key]?.breakpointOverridable === true
    if (activeBreakpointId && activeBreakpointId !== 'desktop' && isOverridable) {
      setBreakpointOverride(selectedNodeId, activeBreakpointId, { [key]: value })
    } else {
      updateNodeProps(selectedNodeId, { [key]: value })
    }
  }

  return {
    commitStyle,
    commitStyleMany,
    clearStylePreview,
    commitProp,
  }
}
