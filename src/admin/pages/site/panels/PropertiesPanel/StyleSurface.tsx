/**
 * StyleSurface — unified properties editor surface (Track P, P1 rewrite; P4
 * rewires it onto `SelectionModel`/the section manifest, `STATE.md`
 * `panel-23`).
 *
 * `STUDIO-LIVE-CANVAS-PLAN.md` §P1 names three things "gone from day one":
 * the module-settings accordion, the inline/class composers drawn as CSS
 * property LISTS, and the sticky search bar + icon rail chrome around them.
 * All three are gone from this file. What survives, unchanged in shape, is
 * the SECTION CONTENT — `StyleSectionsEditor` and everything under it
 * (`docs/features/inspector-disclosure.md`'s laws, the field model, token
 * autocomplete, provenance) — now called exactly ONCE per selection, over
 * one collapsed style bag (`../../inspector/collapsedStyleBag.ts`) instead
 * of two independent Element/Class renders.
 *
 * P4 replaced this file's own 9-prop `WriteTargetStyleComposer` call with the
 * section manifest (`../../inspector/sections`): this component no longer
 * computes `inlineWritable`/`classChain`/`computedValues`/
 * `provenanceByProperty`/`classLockInfo`/`writableClasses`/`writeTargetChips`
 * itself — it reads `useSelectionModel()` once for those facts and renders
 * `designPrimarySections(model)`, each a bare, prop-less `<Component />` that
 * reads the same model/commit hooks itself. This is the mount mechanism P3
 * (the section-by-section re-skin) consumes — growing `INSPECTOR_SECTIONS`
 * never needs to touch this file again.
 *
 * ## The one More disclosure (S5 — the 900px budget)
 *
 * `designMoreSections(model)` is the SAME mount loop, run a second time
 * inside a single collapsed `Section title="More"` at the very end of the
 * tab. Four Studio-extras sections live there (Transform, Animations,
 * Interaction, Custom properties) — see `inspector/sections/index.ts`'s own
 * `designGroup` doc for why those four and no others, and
 * `docs/features/inspector.md` §6 for the budget this buys back. Nothing
 * about a section changes by being in the group: same component, same
 * `data-section-id` wrapper, same order.
 *
 * ## What this file still owns
 *
 *   - The Module section (no longer an accordion — a fixed block, matching
 *     P2 rule 2's "everything is at rest"). Export (P3 item 10) is no longer
 *     mounted here — it moved to its own `INSPECTOR_SECTIONS` manifest entry
 *     (`inspector/sections/ExportSection.tsx`), gated by its own `appliesTo`
 *     rather than the bespoke `studioSession`/`activePageId` conditional this
 *     file used to compute for it.
 *   - The one full-column notice for the genuine "nothing here is writable"
 *     case — role permission, or every reachable target locked.
 *
 * ## Each section is its own failure domain
 *
 * `panel-40` — `MountedSections` wraps every entry in a `PanelBoundary`
 * (`frame="section"`), so a section that throws during render leaves the other
 * fifteen, the tab strip, the canvas and the layers tree untouched and renders
 * its own header plus one line in place. See `ui/PanelBoundary`'s own doc for
 * why the nearest boundary used to be the whole editor body.
 */

import type { ReactNode } from 'react'
import type { StyleRule } from '@core/page-tree'
import { isGeneratedClassLocked, styleRuleDisplayName } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { EmptyState } from '@ui/components/EmptyState'
import { Section } from '@ui/components/Section'
import { PanelBoundary } from '@site/ui/PanelBoundary'
import { MultiSelectTargetBar } from '@site/inspector/MultiSelectTargetBar'
import { useSelectionModel, type SelectionModel } from '@site/inspector/selectionModel'
import {
  designMoreSections,
  designPrimarySections,
  type InspectorSectionDefinition,
} from '@site/inspector/sections'
import styles from './StyleSurface.module.css'

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { GeneratedUtilityLockedState }

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSurfaceProps {
  /** The module's whole block — header and rows (`ModuleBlock`), or `null`. */
  moduleContent?: ReactNode
  /** Called when 'Add class' is clicked in the fully-locked notice. */
  onFocusClassPicker?: () => void
}

// ---------------------------------------------------------------------------
// StyleSurface
// ---------------------------------------------------------------------------

export function StyleSurface({ moduleContent, onFocusClassPicker }: StyleSurfaceProps) {
  const model = useSelectionModel()
  const { selectedNodeId: nodeId, assignedClassRules, writableClasses, inlineWritable, inlineLockReason } = model

  const permissions = useEditorPermissions()
  const canEditStyleHere = permissions.canEditStyle

  const reachableClasses = writableClasses.filter((entry) => entry.lockReason === null)
  const nothingWritable = !inlineWritable && reachableClasses.length === 0

  // A node whose ENTIRE assigned-class story is generated utility classes
  // (framework color/spacing tokens, …) gets the same "not meant to be
  // edited" notice `SelectorInspector`'s global surface shows for one —
  // still ABOVE the mounted sections, not instead of them, because the
  // element's inline layer is a real, separate, still-editable target.
  const soleGeneratedUtility =
    assignedClassRules.length > 0 && assignedClassRules.every((cls) => isGeneratedClassLocked(cls))
      ? assignedClassRules[0]
      : null

  return (
    // `data-testid` is additive/queryable-only — no visual or behavioral
    // change. `.surface` is "THE scroll container" (this file's own CSS
    // comment); the e2e measurement gate
    // (`tests/e2e/inspector-panel-measurement.e2e.ts`) needs a stable real-
    // DOM handle on it since CSS Module class names are hashed in a real
    // build.
    <div className={styles.surface} data-testid="properties-panel-scroll">
      <div className={styles.surfaceContent}>
        {/* A multi-selection's write target is a CHOICE with a blast radius,
            so it gets its own interactive chip + gate here. A SINGLE
            selection's targets are stated once, on `ClassPicker`'s own pills
            (panel-41) — this file used to draw a second, read-only
            `WriteTargetRow` listing the same selectors 40px below that
            stack, which is the panel's own copy of the ambiguity WS-6.2
            exists to fix. */}
        {model.isMultiSelect && <MultiSelectTargetBar model={model} />}

        {/* Module section — P2 rule 2 ("everything is at rest"): a fixed
            block, not an accordion. `moduleContent` is the whole block
            (`ModuleBlock`, built by `renderModuleTabContent`), header
            included; this file mounts it and nothing more. It is `null` when
            there is genuinely nothing to show (global selector mode), and is
            not mounted at all for a multi-selection, whose module props
            belong to one call site each (`commitApi.ts`). */}
        {moduleContent != null && !model.isMultiSelect && (
          // `data-section-id` as well as `data-style-section`: this block is
          // not an `INSPECTOR_SECTIONS` entry, which is exactly why it went
          // unbudgeted until panel-37 measured it at 158px on a text node and
          // 252px on an image. The measured artefact
          // (`docs/audits/penpot-inspector-baseline/05-section-heights.json`)
          // keys off `data-section-id`, so carrying one puts the Module block
          // in the same table as every real section and makes it impossible
          // to grow it again without the number showing up.
          <div key={nodeId} data-style-section="module" data-section-id="module">
            {moduleContent}
          </div>
        )}

        {!canEditStyleHere ? (
          <div className={styles.lockedContent}>
            <EmptyState
              variant="centered"
              title="Styles are read-only for your role"
              description="Your role can edit page copy but not classes or style overrides. Ask an editor to make visual changes."
            />
          </div>
        ) : nodeId == null ? null : nothingWritable ? (
          <NothingWritableNotice reason={inlineLockReason} onFocusClassPicker={onFocusClassPicker} />
        ) : (
          <>
            {soleGeneratedUtility && (
              <div className={styles.lockedContent}>
                <GeneratedUtilityLockedState cls={soleGeneratedUtility} />
              </div>
            )}
            <MountedSections sections={designPrimarySections(model)} />
            <MoreDisclosure model={model} />
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MountedSections — the ONE mount loop, used by both the continuous scroll
// and the More disclosure so a section's wrapper/keying can never differ
// between the two groups.
//
// `data-section-id` is additive/queryable-only — no visual or behavioral
// change. It gives Playwright a stable per-section root
// (`tests/e2e/inspector-panel-measurement.e2e.ts`,
// `tests/e2e/inspector-height.e2e.ts`) since this loop otherwise has no
// wrapper around each section.
// ---------------------------------------------------------------------------

function MountedSections({ sections }: { sections: ReadonlyArray<InspectorSectionDefinition> }) {
  return (
    <>
      {sections.map((section) => (
        <div data-section-id={section.id} key={section.id}>
          {/* `panel-40` — one section is one failure domain. The boundary sits
              INSIDE the `data-section-id` wrapper so a crashed section still
              answers every existing per-section query (the measurement
              artefact, the height gate), and its fallback occupies the
              section's own geometry rather than collapsing the scroll around
              it. No `resetKeys`: a section that throws on every node must not
              be cleared silently by the next canvas click — the fallback's own
              "Reload this panel" is the way back. */}
          <PanelBoundary id={section.id} label={section.label} frame="section">
            <section.Component />
          </PanelBoundary>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// MoreDisclosure — the single collapsed group holding every `designGroup:
// 'more'` section. Renders nothing at all when the selection mounts none of
// them, rather than an empty "More" header that discloses nothing (Law 1,
// `docs/features/inspector.md` §1).
// ---------------------------------------------------------------------------

function MoreDisclosure({ model }: { model: SelectionModel }) {
  const sections = designMoreSections(model)
  if (sections.length === 0) return null
  return (
    <div data-section-id="more" data-testid="inspector-more-disclosure">
      <Section title="More" flush>
        <MountedSections sections={sections} />
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NothingWritableNotice — the one full-column notice left in this file: no
// class is writable AND inline is unreachable. Rare (most nodes reach the
// mounted sections above) but genuinely different from every other state.
// ---------------------------------------------------------------------------

function NothingWritableNotice({
  reason,
  onFocusClassPicker,
}: {
  /** The specific reason inline is unreachable, when there is one — module
   *  ownership, role permission, or a structural lock. Falls back to a
   *  generic "nothing writable" sentence when there isn't (no class, no
   *  node-specific reason — e.g. global-selector mode never reaches here). */
  reason?: string | null
  onFocusClassPicker?: () => void
}) {
  return (
    <div className={styles.lockedPreview}>
      <div className={styles.lockedPreviewCta}>
        <p className={styles.lockedPreviewCtaText}>
          {reason ?? 'Nothing on this element can be saved from here — add a class Studio can write to.'}
        </p>
        {onFocusClassPicker && (
          <div className={styles.lockedPreviewCtaActions}>
            <Button variant="secondary" size="sm" onClick={onFocusClassPicker}>
              Add class
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GeneratedUtilityLockedState — kept for `SelectorInspector.tsx`'s global
// (ambient/class) editing surface, which still shows exactly ONE class at a
// time and has no merged bag to fold this into.
// ---------------------------------------------------------------------------

function GeneratedUtilityLockedState({ cls }: { cls: StyleRule }) {
  const colorGenerated = cls.generated?.family === 'color' ? cls.generated : undefined
  const utility = colorGenerated?.utility
  const tokenName = cls.generated?.tokenName

  return (
    <div className={styles.generatedUtilityState}>
      <div className={styles.generatedUtilityHeader}>
        <span className={styles.generatedUtilityKicker}>Generated utility</span>
        <span className={styles.generatedUtilityName}>.{styleRuleDisplayName(cls)}</span>
      </div>
      <p className={styles.generatedUtilityCopy}>
        This is a utility class. Utility classes have a single purpose and aren&apos;t meant to be
        edited.
      </p>
      {(utility || tokenName) && (
        <div className={styles.generatedUtilityMeta}>
          {utility && <span>{utility}</span>}
          {tokenName && <span>{tokenName}</span>}
        </div>
      )}
    </div>
  )
}
