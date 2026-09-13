/**
 * WriteTargetStyleComposer — the collapsed, single-call replacement for
 * `StyleSurface`'s old independent `InlineStyleComposer` / `StyleRuleComposer`
 * pair (Track P, P1).
 *
 * The old surface rendered TWO blocks — "Element" and the active class — each
 * with its own `StyleSectionsEditor`, so a user had to know which block a
 * value lived in before they could change it. This component renders
 * `StyleSectionsEditor` exactly ONCE, over a bag that merges every source the
 * node carries (`collapsedStyleBag.ts`), and decides per-property, per-commit,
 * WHERE a write lands (`resolveWriteTarget.ts`) — "the write target is a
 * rule, not a mode."
 *
 * Explicitly disposable: P4's `SelectionModel` / `commitStyle` unification
 * replaces this file wholesale, not by extending it — see
 * `resolveWriteTarget.ts`'s own doc for what that means for this file's
 * scope (no coalescing across a multi-property patch beyond "resolve once,
 * from the first key").
 */
import { useEditorStore } from '@site/store/store'
import { styleValueKey, type CSSPropertyBag, type StyleRule } from '@core/page-tree'
import { StyleSectionsEditor } from '../panels/PropertiesPanel/StyleSectionsEditor'
import { ALL_CURATED_CSS_PROPERTIES } from '../panels/PropertiesPanel/cssControlTypes'
import { getActiveStyleTab } from '../panels/PropertiesPanel/classStyleSections'
import { cssPropertyLabel } from '../panels/PropertiesPanel/cssControlTypes'
import { buildClassChain, type PropertyProvenance } from '../panels/PropertiesPanel/stylePropertyProvenance'
import { buildCollapsedCurrentStyles, buildCollapsedStoredStyles, buildContextOnlyClassChain } from './collapsedStyleBag'
import { resolveExistingWriteTarget, resolveWriteTarget, type WriteTargetClassCandidate } from './resolveWriteTarget'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import noticeStyles from '../panels/PropertiesPanel/SharedComponentNotice.module.css'

const EMPTY_CODE_PROPS: readonly string[] = []
const STYLE_KEY_PREFIX = styleValueKey('')

interface WriteTargetStyleComposerProps {
  nodeId: string
  /** Every class assigned to the node, in `classIds` order. */
  assignedClassRules: StyleRule[]
  /** Classes among the above that a NEW declaration can actually reach disk through. */
  writableClasses: ReadonlyArray<WriteTargetClassCandidate>
  inlineStyles: Record<string, unknown>
  /** Whether a NEW inline declaration would reach disk at all (role, module, structural lock). */
  inlineWritable: boolean
  codeProps?: string[]
  computedValues?: Record<string, string> | null
  /** Effective (base+override), cross-class provenance — used for the CURRENT/placeholder layer and for choosing which class a commit targets. */
  provenanceByProperty: ReadonlyMap<string, PropertyProvenance>
  styleTarget?: { nodeId: string; assignedClassIds: ReadonlyArray<string> }
  textFirst?: boolean
}

export function WriteTargetStyleComposer({
  nodeId,
  assignedClassRules,
  writableClasses,
  inlineStyles,
  inlineWritable,
  codeProps,
  computedValues,
  provenanceByProperty,
  styleTarget,
  textFirst,
}: WriteTargetStyleComposerProps) {
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const cs = s.site?.conditions
    return cs && cs.some((c) => c.id === id) ? id : null
  })
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)
  const updateClassStyles = useEditorStore((s) => s.updateClassStyles)
  const setClassContextStyles = useEditorStore((s) => s.setClassContextStyles)
  const removeClassStyleProperty = useEditorStore((s) => s.removeClassStyleProperty)
  const clearClassStyleProperties = useEditorStore((s) => s.clearClassStyleProperties)
  const setPreviewClassStyles = useEditorStore((s) => s.setPreviewClassStyles)
  const clearPreviewClassStyles = useEditorStore((s) => s.clearPreviewClassStyles)
  const setPreviewNodeStyles = useEditorStore((s) => s.setPreviewNodeStyles)
  const clearPreviewNodeStyles = useEditorStore((s) => s.clearPreviewNodeStyles)

  const onCondition = activeConditionId !== null
  const activeTab = getActiveStyleTab(activeBreakpointId)
  const activeContextId = onCondition ? activeConditionId : activeTab !== 'base' ? activeTab : null

  const lockedProperties = (codeProps ?? EMPTY_CODE_PROPS)
    .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
    .map((name) => name.slice(STYLE_KEY_PREFIX.length))
  const lockedPropertySet = new Set(lockedProperties)

  const inlineWritableFor = (property: string) => inlineWritable && !lockedPropertySet.has(property)

  const targetFor = (property: string, existing: boolean) => {
    const provenance = provenanceByProperty.get(property)
    const params = { provenance, inlineWritable: inlineWritableFor(property), writableClasses }
    return existing ? resolveExistingWriteTarget(params) : resolveWriteTarget(params)
  }

  const writeToTarget = (
    target: ReturnType<typeof resolveWriteTarget>,
    patch: Record<string, string | number | null>,
  ) => {
    if (target.kind === 'inline') {
      setNodeInlineStyles(nodeId, patch)
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

  const handleChange = (property: keyof CSSPropertyBag, value: string | number | undefined) => {
    const key = String(property)
    if (lockedPropertySet.has(key)) return
    writeToTarget(targetFor(key, false), { [key]: value ?? null })
  }

  const handleRemove = (property: keyof CSSPropertyBag) => {
    const key = String(property)
    if (lockedPropertySet.has(key)) return
    writeToTarget(targetFor(key, true), { [key]: null })
  }

  const handleClearProperty = (property: keyof CSSPropertyBag) => {
    const key = String(property)
    if (lockedPropertySet.has(key)) return
    const target = targetFor(key, true)
    if (target.kind === 'class') {
      removeClassStyleProperty(target.classId, property)
    } else if (target.kind === 'inline') {
      setNodeInlineStyles(nodeId, { [key]: null })
    }
  }

  const handleClearProperties = (properties: ReadonlyArray<keyof CSSPropertyBag>) => {
    const clearable = properties.filter((p) => !lockedPropertySet.has(String(p)))
    if (clearable.length === 0) return
    // Resolved once, from the first property — see this file's module doc.
    const target = targetFor(String(clearable[0]), true)
    if (target.kind === 'class') {
      clearClassStyleProperties(target.classId, clearable)
    } else if (target.kind === 'inline') {
      setNodeInlineStyles(nodeId, Object.fromEntries(clearable.map((p) => [String(p), null])))
    }
  }

  const handleChangeMany = (patch: Record<string, string | number | null>) => {
    const keys = Object.keys(patch).filter((k) => !lockedPropertySet.has(k))
    if (keys.length === 0) return
    const target = targetFor(keys[0], false)
    const filteredPatch = Object.fromEntries(keys.map((k) => [k, patch[k]]))
    writeToTarget(target, filteredPatch)
  }

  const handlePreview = (patch: Partial<CSSPropertyBag>) => {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const target = targetFor(keys[0], false)
    if (target.kind === 'class') {
      if (onCondition) return // the class preview channel has no conditional-layer target — see StyleRuleComposer's identical guard.
      setPreviewClassStyles({
        classId: target.classId,
        breakpointId: activeTab !== 'base' ? activeTab : null,
        styles: patch,
      })
    } else if (target.kind === 'inline') {
      setPreviewNodeStyles({ nodeId, styles: patch })
    }
  }

  const handleClearPreview = () => {
    clearPreviewClassStyles()
    clearPreviewNodeStyles(nodeId)
  }

  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(
    ALL_CURATED_CSS_PROPERTIES,
    contextOnlyClassChain,
    inlineStyles,
  )
  // The "effective" bag (base merged with the active context's override) for
  // the CURRENT/placeholder layer — the same shape `StyleSurface`'s own
  // `classChain` (fed to `provenanceByProperty`) already uses.
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  const sectionKey = `${nodeId}-${activeContextId ?? 'base'}`
  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]

  return (
    <>
      {lockedProperties.length > 0 && (
        <div className={noticeStyles.notice} role="note" data-testid="inline-style-locked-properties-notice">
          <LockSolidIcon size={14} className={noticeStyles.icon} />
          <p className={noticeStyles.text}>
            {lockedProperties.length === 1 ? (
              <>
                <strong>{cssPropertyLabel(lockedProperties[0])}</strong> is set from an expression in
                code and stays read-only here.
              </>
            ) : (
              <>
                <strong>{lockedProperties.map(cssPropertyLabel).join(', ')}</strong> are set from
                expressions in code and stay read-only here.
              </>
            )}
          </p>
        </div>
      )}
      <StyleSectionsEditor
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        crossContextStyles={crossContextStyles}
        sectionKey={sectionKey}
        styleQuery=""
        onChange={handleChange}
        onRemove={handleRemove}
        onClearProperty={handleClearProperty}
        onClearProperties={handleClearProperties}
        onChangeMany={handleChangeMany}
        onPreview={handlePreview}
        onClearPreview={handleClearPreview}
        provenanceByProperty={provenanceByProperty}
        styleTarget={styleTarget}
        textFirst={textFirst}
      />
    </>
  )
}

