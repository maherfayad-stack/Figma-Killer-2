/**
 * ExportSection — Penpot's Export section (`STATE.md` `panel-25`, item 10 of
 * the P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3;
 * `docs/features/inspector-disclosure.md` §4 G11). Migrated onto its own
 * `INSPECTOR_SECTIONS` manifest entry, mirroring items 1-9's own posture:
 * takes no props, renders `null` on no selection. It was already the
 * closest section to P3-shaped before this pass (node-level, single mount,
 * already Step-0-token-correct) — this migration is a relocation, not a
 * redesign; see `STATE.md` `panel-25`'s own mapping table row for item 10.
 *
 * Law 1 in full (§1): an element nobody is exporting costs exactly one header
 * line and a `+`. The `+` is the typed menu — @1×/@2×/@3× PNG, SVG, Copy CSS,
 * Copy JSX — because adding an export means choosing a FORMAT, not just
 * opening a body, the same reason Fill's and Shadow's headers carry typed
 * menus rather than the generic reveal button.
 *
 * ## Why this section is NOT in `classStyleSections.ts` (and never was)
 *
 * Every entry in that registry is a set of CSS PROPERTIES on a style target.
 * Export is a statement about the NODE — the same export whichever style
 * target happens to be open, meaningful on an element with no class at all,
 * and matching no property search. So it was always registered where
 * node-level sections belong; P3 simply moves that mount from a hand-wired
 * spot at the bottom of `StyleSurface.tsx` into the same section manifest
 * every CSS-property section now uses (`sections/index.ts`), gated by its
 * own `appliesTo` rather than a bespoke conditional in the shell.
 *
 * ## Why this section reads no `useInspectorCommit`
 *
 * Every section before this one in the series (items 1-9) calls
 * `useInspectorCommit(model)` because every one of them WRITES a CSS
 * property. Export writes nothing to the node — its four verbs are a file
 * download, two clipboard copies, and a server read of the node's own JSX —
 * so there is no commit API to call here. This is the node-level shape the
 * dispatch for this section warned about: don't force a class-style-shaped
 * API onto data that was never class-style-shaped.
 *
 * ## Why this section still reads its own store selectors beyond `SelectionModel`
 *
 * `SelectionModel` (`panel-23`) is deliberately narrow to the class/style
 * write path and exposes neither the active page id nor whether the active
 * page is a Studio-parsed one. Export needs both — the PNG/JSX routes are
 * keyed by page, and the section has no reason to exist outside a Studio
 * session (a CMS page has no `.tsx` for Copy JSX to read, and its DOM never
 * carries `data-node-id` for a PNG crop). Both are read here as their own
 * narrow selectors — the identical shape `StyleSurface.tsx` used to compute
 * them before this migration — rather than widening `SelectionModel`'s
 * public shape for this one, node-level consumer.
 *
 * ## Rows are session state, deliberately
 *
 * Figma persists export settings in the file. Studio's file is the user's
 * repository, and writing an `export: png@2x` marker comment into their `.tsx`
 * to remember a checkbox is not a trade this tool makes. So the rows live in
 * component state, keyed by node via this component's own `key={nodeId}` at
 * the manifest mount site — they survive while you work on an element and
 * are gone when you select another one.
 */
import { useRef, useState } from 'react'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { isStudioPageRootId, styleRuleSelector, type PageNode } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { Section } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import sectionStyles from '@ui/components/Section/Section.module.css'
import { useSelectionModel } from '../selectionModel'
import { ALL_CURATED_CSS_PROPERTIES } from '../../panels/PropertiesPanel/cssControlTypes'
import {
  collectNodeCssDeclarations,
  exportFormatLabel,
  exportRowLabel,
  exportScaleLabel,
  formatNodeCss,
  NODE_EXPORT_MENU,
  type NodeExportMenuEntry,
  type NodeExportRow,
} from '../../panels/PropertiesPanel/nodeExportModel'
import {
  copyPngToClipboard,
  copyTextToClipboard,
  downloadNodePng,
  downloadNodeSvg,
  readNodeJsxSource,
} from '../../panels/PropertiesPanel/nodeExportClient'
import type { PropertyProvenance } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import styles from './ExportSection.module.css'

/** The platform-correct keyboard hint for a menu entry, straight from the registry. */
function menuEntryShortcut(entry: NodeExportMenuEntry): string | null {
  if (!entry.commandId) return null
  const binding = getKeybindingForCommand(entry.commandId)
  return binding ? formatShortcut(binding.shortcut) : null
}

export function ExportSection() {
  const model = useSelectionModel()
  const { selectedNodeId: nodeId, selectedNode, assignedClassRules, provenanceByProperty } = model

  // Node-level facts `SelectionModel` deliberately doesn't carry — see this
  // file's own doc for why they're read here instead of added there.
  const activePageId = useEditorStore((s) => s.activePageId)
  const studioSession = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page != null && isStudioPageRootId(page.rootNodeId)
  })

  if (nodeId == null || selectedNode == null || activePageId == null || !studioSession) return null

  // `key={nodeId}` — the pre-migration mount's own `<ExportSection
  // key={nodeId} .../>` remount trick, reproduced here rather than lost:
  // the row list is deliberately unpersisted session state (see this file's
  // own "Rows are session state" doc), so it must reset when the selection
  // moves to a different node. The section manifest's own mount loop
  // (`StyleSurface.tsx`) keys every entry by `section.id` — a constant — so
  // this component supplies its OWN node-keyed remount internally instead of
  // relying on the shell for it.
  return (
    <ExportSectionBody
      key={nodeId}
      nodeId={nodeId}
      pageId={activePageId}
      node={selectedNode}
      classSelectors={assignedClassRules.map((rule) => styleRuleSelector(rule))}
      provenanceByProperty={provenanceByProperty}
    />
  )
}

// ---------------------------------------------------------------------------
// ExportSectionBody — the per-selection body. Not itself registered in the
// manifest (only `ExportSection` above is); this is what gets remounted,
// resetting its own local state, every time `nodeId` changes.
// ---------------------------------------------------------------------------

interface ExportSectionBodyProps {
  nodeId: string
  pageId: string
  node: PageNode
  classSelectors: ReadonlyArray<string>
  provenanceByProperty: ReadonlyMap<string, PropertyProvenance>
}

function ExportSectionBody({ nodeId, pageId, node, classSelectors, provenanceByProperty }: ExportSectionBodyProps) {
  const [rows, setRows] = useState<NodeExportRow[]>([])
  const [runningRowId, setRunningRowId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const addTriggerRef = useRef<HTMLButtonElement>(null)
  // Row ids only have to be unique within this list, and the list is per
  // selection — a counter is the whole requirement.
  const nextRowIdRef = useRef(0)

  const nodeLabel = node.label || 'Element'

  function handleMenuEntry(entry: NodeExportMenuEntry) {
    setMenuOpen(false)
    if (entry.action.kind === 'add-row') {
      nextRowIdRef.current += 1
      const row: NodeExportRow = {
        id: `export-${nextRowIdRef.current}`,
        format: entry.action.format,
        scale: entry.action.scale,
      }
      setRows((current) => [...current, row])
      return
    }
    if (entry.action.kind === 'copy-png') {
      void copyPng(entry.action.scale)
      return
    }
    if (entry.action.kind === 'copy-css') {
      void copyCss()
      return
    }
    void copyJsx()
  }

  /**
   * The clickable twin of ⌘⇧C. Same endpoint, same density, same toast — the
   * menu entry exists so the shortcut is DISCOVERABLE, not so there are two
   * implementations of copying a PNG.
   */
  async function copyPng(scale: 1 | 2 | 3) {
    try {
      await copyPngToClipboard({ pageId, nodeId, scale })
      pushToast({ kind: 'success', title: 'Copied as PNG', body: `${nodeLabel} @${scale}×` })
    } catch (err) {
      console.error('[ExportSection] copy as PNG failed:', err)
      pushToast({ kind: 'error', title: 'Copy as PNG failed', body: getErrorMessage(err, 'Unknown export error') })
    }
  }

  async function copyCss() {
    const declarations = collectNodeCssDeclarations(ALL_CURATED_CSS_PROPERTIES, provenanceByProperty)
    if (declarations.length === 0) {
      pushToast({
        kind: 'error',
        title: 'Nothing to copy',
        body: 'No CSS is declared on this element yet — style it, or copy from an element that carries a class or an inline style.',
      })
      return
    }
    const css = formatNodeCss({
      title: nodeLabel,
      ...(classSelectors.length > 0 ? { selector: classSelectors.join('') } : {}),
      declarations,
    })
    try {
      await copyTextToClipboard(css)
      pushToast({ kind: 'success', title: `Copied ${declarations.length} declarations` })
    } catch (err) {
      console.error('[ExportSection] copy CSS failed:', err)
      pushToast({ kind: 'error', title: 'Copy CSS failed', body: getErrorMessage(err, 'Unknown clipboard error') })
    }
  }

  async function copyJsx() {
    try {
      await copyTextToClipboard(await readNodeJsxSource(nodeId))
      pushToast({ kind: 'success', title: 'Copied JSX' })
    } catch (err) {
      console.error('[ExportSection] copy JSX failed:', err)
      pushToast({ kind: 'error', title: 'Copy JSX failed', body: getErrorMessage(err, 'Unknown export error') })
    }
  }

  async function runRow(row: NodeExportRow) {
    setRunningRowId(row.id)
    try {
      if (row.format === 'png') {
        await downloadNodePng({ pageId, nodeId, nodeLabel, row })
      } else {
        await downloadNodeSvg({ node, nodeLabel, row })
      }
    } catch (err) {
      console.error('[ExportSection] export failed:', err)
      pushToast({
        kind: 'error',
        title: `${exportFormatLabel(row.format)} export failed`,
        body: getErrorMessage(err, 'Unknown export error'),
      })
    } finally {
      setRunningRowId(null)
    }
  }

  const addButton = (
    <>
      <Button
        ref={addTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Add export"
        tooltip="Add export"
        data-testid="export-section-add"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <PlusIcon size={12} aria-hidden="true" />
      </Button>
      {menuOpen && (
        <ContextMenu
          ariaLabel="Add export"
          anchorRef={addTriggerRef}
          triggerRef={addTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          onClose={() => setMenuOpen(false)}
        >
          {NODE_EXPORT_MENU.map((entry) => (
            <ContextMenuItem key={entry.id} onClick={() => handleMenuEntry(entry)}>
              {entry.label}
              {menuEntryShortcut(entry) ? (
                <span className={styles.menuShortcut}>{menuEntryShortcut(entry)}</span>
              ) : null}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )

  // Law 1's rest state: no export configured, so one header line and the
  // "+" — `Section`'s `empty` prop (no chevron, no toggle, no body), the
  // same primitive Fill/Shadow use for their own rest state, rather than the
  // pre-migration file's `defaultOpen={false}`/`children={null}` shape,
  // which left a clickable (if inert) chevron on an empty section.
  if (rows.length === 0) {
    return <Section title="Export" icon={ArrowBarDownIcon} empty flush actions={addButton} />
  }

  const entries: PropertyListEntry<NodeExportRow>[] = rows.map((row) => ({
    id: row.id,
    label: exportRowLabel(row),
    leading:
      row.format === 'png' ? (
        <ImageSolidIcon size={12} aria-hidden="true" />
      ) : (
        <Image2SolidIcon size={12} aria-hidden="true" />
      ),
    summary: exportFormatLabel(row.format),
    value: (
      <span className={styles.rowTrailing}>
        <span className={styles.scaleChip}>{exportScaleLabel(row)}</span>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          disabled={runningRowId !== null}
          aria-label={`Export ${exportRowLabel(row)}`}
          tooltip={`Export ${exportRowLabel(row)}`}
          data-testid={`export-run-${row.id}`}
          onClick={() => void runRow(row)}
        >
          {runningRowId === row.id ? (
            <LoaderIcon size={12} aria-hidden="true" className={styles.runningIcon} />
          ) : (
            <ArrowBarDownIcon size={12} aria-hidden="true" />
          )}
        </Button>
      </span>
    ),
    data: row,
  }))

  return (
    <Section
      title="Export"
      icon={ArrowBarDownIcon}
      forceOpen
      flush
      indicator
      indicatorTestId="export-section-dot"
      meta={`${rows.length} ready`}
      actions={addButton}
    >
      <div className={sectionStyles.sectionBody}>
        <PropertyList
          listLabel="Exports"
          entries={entries}
          onRemove={(entry) => setRows((current) => current.filter((row) => row.id !== entry.data.id))}
          addTriggerRef={addTriggerRef}
        />
      </div>
    </Section>
  )
}
