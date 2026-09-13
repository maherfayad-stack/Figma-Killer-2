/**
 * StyleSectionsComposer — the P4 successor to `WriteTargetStyleComposer.tsx`
 * (`STATE.md` `panel-23`, Phase B item 2).
 *
 * Same job, same JSX shape (a locked-properties notice above exactly ONE
 * `<StyleSectionsEditor>` over the node's merged style bag,
 * `collapsedStyleBag.ts`), but the two things that made
 * `WriteTargetStyleComposer` a 9-prop component are gone: it reads
 * `useSelectionModel()` for every selection fact instead of taking them as
 * props, and it builds `StyleSectionsEditor`'s 7 handlers as thin calls into
 * `useInspectorCommit(model)` instead of resolving a `WriteTarget` and
 * calling 8 raw store actions inline.
 *
 * Takes no props at all — the section manifest (`./index.ts`) mounts every
 * entry as a bare `<Component />`, so a section's ONLY inputs are the
 * selection-scoped hooks it calls itself.
 *
 * ## Mapping `StyleSectionsEditor`'s 7 handlers onto `InspectorCommitApi`
 *
 *   - `onChange`          -> `commitStyle(prop, value ?? null)` — single-context set.
 *   - `onRemove`          -> `commitStyle(prop, null, { existing: true })` — single-context null-set, existing target only (matches the old `handleRemove`, NOT a cross-context purge).
 *   - `onClearProperty`   -> `commitStyleMany({ [prop]: null }, { mode: 'clear' })` — a ONE-key batch call. `clearClassStyleProperties`/`removeClassStyleProperty` are the same cross-context-purge semantics for N=1 vs N=many (verified against `propertyActions.ts`), so this is exactly the old `handleClearProperty`'s behaviour, not an approximation of it.
 *   - `onClearProperties` -> `commitStyleMany(patch, { mode: 'clear' })` — the real batch purge.
 *   - `onChangeMany`      -> `commitStyleMany(patch)` — `mode: 'set'` (default).
 *   - `onPreview`         -> `commitStyleMany(patch, { preview: true })`.
 *   - `onClearPreview`    -> `clearStylePreview()`.
 */
import { StyleSectionsEditor } from '../../panels/PropertiesPanel/StyleSectionsEditor'
import { ALL_CURATED_CSS_PROPERTIES, cssPropertyLabel } from '../../panels/PropertiesPanel/cssControlTypes'
import { isTextNode } from '../../panels/PropertiesPanel/styleSectionOrder'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { buildCollapsedCurrentStyles, buildCollapsedStoredStyles, buildContextOnlyClassChain } from '../collapsedStyleBag'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { styleValueKey, type CSSPropertyBag } from '@core/page-tree'
import noticeStyles from '../../panels/PropertiesPanel/SharedComponentNotice.module.css'

const EMPTY_CODE_PROPS: readonly string[] = []
const STYLE_KEY_PREFIX = styleValueKey('')

export function StyleSectionsComposer() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues, provenanceByProperty } = model

  if (selectedNodeId == null || selectedNode == null) return null

  const lockedProperties = (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
    .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
    .map((name) => name.slice(STYLE_KEY_PREFIX.length))

  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(
    ALL_CURATED_CSS_PROPERTIES,
    contextOnlyClassChain,
    inlineStyles,
  )
  // The "effective" bag (base merged with the active context's override) for
  // the CURRENT/placeholder layer — the same shape `SelectionModel`'s own
  // `provenanceByProperty` build uses.
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  const sectionKey = `${selectedNodeId}-${activeContextId ?? 'base'}`
  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]

  const styleTarget = { nodeId: selectedNodeId, assignedClassIds: assignedClassRules.map((rule) => rule.id) }
  const textFirst = isTextNode(selectedNode)

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
        onChange={(property, value) => commit.commitStyle(property, value ?? null)}
        onRemove={(property) => commit.commitStyle(property, null, { existing: true })}
        onClearProperty={(property) => commit.commitStyleMany({ [property]: null }, { mode: 'clear' })}
        onClearProperties={(properties) =>
          commit.commitStyleMany(
            Object.fromEntries(properties.map((p) => [p, null])) as Partial<Record<keyof CSSPropertyBag, string | number | null>>,
            { mode: 'clear' },
          )
        }
        onChangeMany={(patch) => commit.commitStyleMany(patch)}
        onPreview={(patch) => commit.commitStyleMany(patch, { preview: true })}
        onClearPreview={commit.clearStylePreview}
        provenanceByProperty={provenanceByProperty}
        styleTarget={styleTarget}
        textFirst={textFirst}
      />
    </>
  )
}
