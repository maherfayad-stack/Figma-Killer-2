/**
 * CustomPropertiesSection (manifest wrapper) — Studio's own "Custom
 * properties" section (`STATE.md` `panel-25`, P3 item 11 — Studio extras,
 * last of the six new entries, order 15 — stays last exactly as it always
 * has: `StyleSectionsEditor.tsx` always rendered it after every curated
 * section).
 *
 * Thin — this is NOT a port of a whole editor. It reads
 * `useSelectionModel()`/`useInspectorCommit(model)`, builds the full curated
 * bag exactly as the now-deleted `StyleSectionsComposer.tsx` did
 * (`buildContextOnlyClassChain` + `buildCollapsedStoredStyles
 * (ALL_CURATED_CSS_PROPERTIES, ...)`), reproduces its own slice of the
 * locked-properties notice (`codeProps` filtered to `style:<prop>` keys —
 * the ONLY slice of that check the other five new sections don't each also
 * owe on their own claimed keys, since a locked CURATED property never
 * reaches this section's own uncurated-only bag anyway), then renders the
 * real editor — `panels/PropertiesPanel/CustomPropertiesSection.tsx`, kept
 * in place and widened with `forceOpen` (see that file's own doc) — with
 * `onChange`/`onRemove` wired to `commit.commitStyle`.
 *
 * `claimsAllProperties: true`. Every OTHER migrated section narrows its own
 * bag to the handful of properties it claims; this one instead claims
 * "every uncurated key" (`!isCuratedProperty`) — the long tail Webflow/
 * Framer-style escape hatch the underlying editor's own doc describes.
 */
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { styleValueKey, type CSSPropertyBag } from '@core/page-tree'
import { ALL_CURATED_CSS_PROPERTIES, cssPropertyLabel, isCuratedProperty } from '../../panels/PropertiesPanel/cssControlTypes'
import { CustomPropertiesSection as CustomPropertiesEditor } from '../../panels/PropertiesPanel/CustomPropertiesSection'
import { buildContextOnlyClassChain, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import noticeStyles from '../../panels/PropertiesPanel/SharedComponentNotice.module.css'

const EMPTY_CODE_PROPS: readonly string[] = []
const STYLE_KEY_PREFIX = styleValueKey('')

export function CustomPropertiesSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId } = model

  if (!selectedNodeId || !selectedNode) return null

  // This section's own slice of the locked-properties notice (`STATE.md`
  // `panel-25`'s Section 11 work order): a locked CURATED property is
  // already covered by its OWN claiming section's notice (Transform,
  // Interaction, …), so only UNCURATED locked keys are this section's to
  // report — the ONLY slice of the check the other five new sections don't
  // each also owe on their own claimed keys.
  const lockedProperties = (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
    .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
    .map((name) => name.slice(STYLE_KEY_PREFIX.length))
    .filter((prop) => !isCuratedProperty(prop))

  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(ALL_CURATED_CSS_PROPERTIES, contextOnlyClassChain, inlineStyles)

  return (
    <>
      {lockedProperties.length > 0 && (
        <div className={noticeStyles.notice} role="note" data-testid="custom-properties-locked-properties-notice">
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
      <CustomPropertiesEditor
        storedStyles={storedStyles}
        defaultOpen
        forceOpen
        onChange={(property, value) => commit.commitStyle(property, value ?? null)}
        onRemove={(property: keyof CSSPropertyBag) => commit.commitStyle(property, null, { existing: true })}
      />
    </>
  )
}
