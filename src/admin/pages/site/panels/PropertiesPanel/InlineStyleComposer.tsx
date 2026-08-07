/**
 * InlineStyleComposer — CSS section editor bound to a node's inline styles.
 *
 * The sibling of `StyleRuleComposer`: same `StyleSectionsEditor` rendering core,
 * but reads from / writes to `node.inlineStyles` (the per-node `style=""`
 * layer the publisher emits) instead of a StyleRule.
 *
 * Inline styles are BASE-ONLY — a real HTML `style=""` attribute cannot be
 * media-queried — so this editor ignores the breakpoint / condition switcher
 * entirely and always edits the single inline bag (sectionKey `'base'`). The
 * canvas hover-preview channel is class-keyed, so preview is a no-op here.
 *
 * Per-property lock (finding R1 / S4 in docs/audits/2026-08-06/09-refusal-states.md).
 * A node's `codeProps` can name individual inline-style properties that were
 * resolved from an expression (`style={{ width: \`${pct}%\` }}`) — the
 * `style:<prop>` namespace `styleValueKey` writes. `setNodeInlineStyles`
 * already refuses those writes via the store guard
 * (`isStylePatchWritableToSource`, `store/slices/site/nodeActions.ts`), but
 * until this fix that refusal was completely silent: no disabled control, no
 * toast, and `SourceConstraintNotice` actively claimed the style controls
 * "say so where the user is already looking" — they didn't say anything.
 * This composer now surfaces the SAME fact the store guard already checks,
 * before the user types anything, so the two can never disagree.
 *
 * This does not yet disable each individual bespoke visual control (the
 * Size/Position/Layout/Spacing/Typography/Background/Border sections each
 * own their own input widgets) — that is the full typed-constraint model,
 * Track F. What it does do: name every locked property up front, and refuse
 * the write client-side too so a user can never observe a value "stick" on
 * the canvas that will not survive a save.
 */

import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { useEditorStore } from '@site/store/store'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { cssPropertyLabel } from './cssControlTypes'
import { StyleSectionsEditor } from './StyleSectionsEditor'
import type { PropertyProvenance } from './stylePropertyProvenance'
import noticeStyles from './SharedComponentNotice.module.css'

/** Stable empty bag for nodes with no inline styles (avoids a fresh object per render). */
const EMPTY_STYLES: Record<string, unknown> = {}
/** Stable empty array — avoids a fresh array identity per render when `codeProps` is absent. */
const EMPTY_CODE_PROPS: readonly string[] = []

const STYLE_KEY_PREFIX = styleValueKey('')

interface InlineStyleComposerProps {
  nodeId: string
  /** The node's current inline styles (re-read from the store on every change). */
  inlineStyles: Record<string, unknown> | undefined
  /** Search query — filters visible properties across all categories. */
  styleQuery: string
  /**
   * `PageNode.codeProps` — filtered here for the `style:<prop>` namespace to
   * find which individual inline-style properties resolved from an
   * expression and therefore cannot be written back (see this file's doc
   * comment). Whole-node/whole-module locks are handled one level up by
   * `StyleSurface`, which doesn't render this composer at all in that case.
   */
  codeProps?: string[]
  /** Track F1 — see `StyleRuleComposer`'s identical prop for the fallback contract. */
  computedValues?: Record<string, string> | null
  /** Track F1 — see `StyleSectionsEditor`'s doc. */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

export function InlineStyleComposer({
  nodeId,
  inlineStyles,
  styleQuery,
  codeProps,
  computedValues,
  provenanceByProperty,
}: InlineStyleComposerProps) {
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)
  const removeNodeInlineStyleProperty = useEditorStore((s) => s.removeNodeInlineStyleProperty)

  const stored: Record<string, unknown> = inlineStyles ?? EMPTY_STYLES
  // Track F1 — same computed-truth-as-base-layer fold `StyleRuleComposer`
  // uses; the node's own inline value (if set) always wins.
  const current: Record<string, unknown> = computedValues ? { ...computedValues, ...stored } : stored

  const lockedProperties = (codeProps ?? EMPTY_CODE_PROPS)
    .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
    .map((name) => name.slice(STYLE_KEY_PREFIX.length))
  const lockedPropertySet = new Set(lockedProperties)

  const handleChange = (key: keyof CSSPropertyBag, value: string | number | undefined) => {
    if (lockedPropertySet.has(String(key))) return
    setNodeInlineStyles(nodeId, { [String(key)]: value ?? null })
  }
  const handleRemove = (key: keyof CSSPropertyBag) => {
    if (lockedPropertySet.has(String(key))) return
    removeNodeInlineStyleProperty(nodeId, String(key))
  }
  // Clear several properties in one undo step (e.g. display + its flex/grid deps).
  const handleClearProperties = (keys: ReadonlyArray<keyof CSSPropertyBag>) => {
    const clearable = keys.filter((k) => !lockedPropertySet.has(String(k)))
    if (clearable.length === 0) return
    setNodeInlineStyles(nodeId, Object.fromEntries(clearable.map((k) => [String(k), null])))
  }

  return (
    <>
      {lockedProperties.length > 0 && (
        <div className={noticeStyles.notice} role="note" data-testid="inline-style-locked-properties-notice">
          <LockSolidIcon size={14} className={noticeStyles.icon} />
          <p className={noticeStyles.text}>
            {lockedProperties.length === 1 ? (
              <>
                <strong>{cssPropertyLabel(lockedProperties[0])}</strong> is set from an expression
                in code and stays read-only here — writing it below would replace the code that
                produces it, so this composer won&apos;t save it.
              </>
            ) : (
              <>
                <strong>{lockedProperties.map(cssPropertyLabel).join(', ')}</strong> are set from
                expressions in code and stay read-only here — this composer won&apos;t save changes
                to them.
              </>
            )}
          </p>
        </div>
      )}
      <StyleSectionsEditor
        // Inline styles have no context axis; the stored bag is the single
        // source of truth for "is this set", `current` additionally folds in
        // the frame's computed value for the unset-placeholder / visual-
        // section-gating cases (Track F1 — see this file's `current` above).
        storedStyles={stored}
        currentStyles={current}
        sectionKey="base"
        styleQuery={styleQuery}
        onChange={handleChange}
        onRemove={handleRemove}
        onClearProperty={handleRemove}
        onClearProperties={handleClearProperties}
        // Hover-preview is class-keyed in the store; skip it for inline editing.
        onPreview={noop}
        onClearPreview={noop}
        provenanceByProperty={provenanceByProperty}
      />
    </>
  )
}

function noop() {}
