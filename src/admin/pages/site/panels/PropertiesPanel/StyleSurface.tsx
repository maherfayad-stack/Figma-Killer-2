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
 *   - The `WriteTargetRow` informational chip strip (presentation only, now
 *     derived from `SelectionModel.writableClasses`/`inlineWritable`/
 *     `inlineLockReason` instead of computing its own class-lock pass).
 *   - The Module section (no longer an accordion — a fixed block, matching
 *     P2 rule 2's "everything is at rest"). Export (P3 item 10) is no longer
 *     mounted here — it moved to its own `INSPECTOR_SECTIONS` manifest entry
 *     (`inspector/sections/ExportSection.tsx`), gated by its own `appliesTo`
 *     rather than the bespoke `studioSession`/`activePageId` conditional this
 *     file used to compute for it.
 *   - The one full-column notice for the genuine "nothing here is writable"
 *     case — role permission, or every reachable target locked.
 */

import type { ReactNode } from 'react'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { StyleRule } from '@core/page-tree'
import { canWriteInlineStyleForModule, isGeneratedClassLocked, styleRuleDisplayName } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { EmptyState } from '@ui/components/EmptyState'
import { Section } from '@ui/components/Section'
import { WriteTargetRow, type WriteTargetChipInfo } from '@site/inspector/WriteTargetRow'
import { useSelectionModel, type SelectionModel } from '@site/inspector/selectionModel'
import {
  designMoreSections,
  designPrimarySections,
  type InspectorSectionDefinition,
} from '@site/inspector/sections'
import styles from './StyleSurface.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { GeneratedUtilityLockedState }

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSurfaceProps {
  definition?: AnyModuleDefinition | null
  /** Pre-rendered module prop rows shown in the Module section. */
  moduleContent?: ReactNode
  /** Called when 'Add class' is clicked in the fully-locked notice. */
  onFocusClassPicker?: () => void
}

// ---------------------------------------------------------------------------
// StyleSurface
// ---------------------------------------------------------------------------

export function StyleSurface({ definition, moduleContent, onFocusClassPicker }: StyleSurfaceProps) {
  const model = useSelectionModel()
  const { selectedNodeId: nodeId, selectedNode, assignedClassRules, writableClasses, inlineWritable, inlineLockReason } = model

  const permissions = useEditorPermissions()
  const canEditStyleHere = permissions.canEditStyle

  // Whether `style=""` is a reachable target AT ALL for this node — distinct
  // from `inlineWritable` (which also requires no structural source lock).
  // A source-locked node still shows the inline chip, struck through with
  // its lock reason (`WriteTargetRow`'s own doc); a role/module-unwritable
  // node doesn't show it at all. Recomputed here from `model.selectedNode`
  // rather than added to `SelectionModel`'s public shape — a cheap, narrow
  // derivation local to this ONE presentational consumer, same posture as
  // `commitApi.ts`'s own independent `lockedPropertySet` recomputation.
  const inlineModuleUnwritable =
    selectedNode?.moduleId !== undefined && !canWriteInlineStyleForModule(selectedNode.moduleId)
  const canToggleElement = canEditStyleHere && nodeId != null && !inlineModuleUnwritable

  const writeTargetChips: WriteTargetChipInfo[] = writableClasses.map((entry) => ({
    key: entry.classId,
    label: entry.selector,
    lockReason: entry.lockReason,
  }))
  const reachableClasses = writableClasses.filter((entry) => entry.lockReason === null)
  // The chip `resolveWriteTarget` would reach for on a brand-new property
  // with no existing declaration anywhere — see that module's "otherwise"
  // branch, mirrored here for the informational row only.
  const defaultTargetKey =
    reachableClasses.length === 1 ? reachableClasses[0].classId : inlineWritable ? 'inline' : null

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

  // definition.icon is an IconComponent — must assign to PascalCase var.
  const ModuleIcon = definition?.icon
  const hasModuleContent = definition != null && moduleContent != null

  return (
    // `data-testid` is additive/queryable-only — no visual or behavioral
    // change. `.surface` is "THE scroll container" (this file's own CSS
    // comment); the e2e measurement gate
    // (`tests/e2e/inspector-panel-measurement.e2e.ts`) needs a stable real-
    // DOM handle on it since CSS Module class names are hashed in a real
    // build.
    <div className={styles.surface} data-testid="properties-panel-scroll">
      <div className={styles.surfaceContent}>
        {nodeId != null && (
          <WriteTargetRow
            classChips={writeTargetChips}
            inlineReachable={canToggleElement}
            inlineLockReason={inlineLockReason}
            defaultTargetKey={defaultTargetKey}
          />
        )}

        {/* Module section — P2 rule 2 ("everything is at rest"): a fixed
            block, not an accordion. `hasModuleContent` still hides it
            entirely when there is genuinely nothing to show (global
            selector mode). */}
        {hasModuleContent && (
          <div data-style-section="module">
            <div className={styles.moduleHeader}>
              {ModuleIcon && <ModuleIcon size={14} aria-hidden="true" />}
              <span className={styles.moduleTitle}>{definition!.name}</span>
            </div>
            <div key={nodeId} className={cn(styles.moduleBody, sectionStyles.sectionBody)}>
              {moduleContent}
            </div>
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
          <section.Component />
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
