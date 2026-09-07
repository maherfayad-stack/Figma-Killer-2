/**
 * ExportSection — Figma's Export block, at the bottom of the inspector
 * (W8-4; `docs/features/inspector-disclosure.md` §4 G11).
 *
 * Law 1 in full (§1): an element nobody is exporting costs exactly one header
 * line and a `+`. The `+` is the typed menu — @1×/@2×/@3× PNG, SVG, Copy CSS,
 * Copy JSX — because adding an export means choosing a FORMAT, not just
 * opening a body, the same reason Effects' and Animations' headers carry typed
 * menus rather than the generic reveal button.
 *
 * ## Why this section is NOT in `classStyleSections.ts`
 *
 * Every entry in that registry is a set of CSS PROPERTIES on a style target,
 * and three things read it that way: `StyleSectionsEditor` renders one copy
 * per open target (the Element block AND the class block), `StyleCategoryRail`
 * derives a rail button that is DISABLED until a class is active, and the
 * search filters sections by the properties they claim.
 *
 * Export is none of those. It is a statement about the NODE — the same export
 * whichever style target happens to be open, meaningful on an element with no
 * class at all, and matching no property search. Registering it there would
 * have produced two Export sections on a node with both targets open, greyed
 * out on exactly the unstyled elements it works fine for. So it is registered
 * where node-level sections belong: mounted once by `StyleSurface`, after the
 * CSS area, gated on there being a node and a Studio project behind it.
 *
 * ## Rows are session state, deliberately
 *
 * Figma persists export settings in the file. Studio's file is the user's
 * repository, and writing `{/* export: png@2x *​/}` into their `.tsx` to
 * remember a checkbox is not a trade this tool makes. So the rows live in
 * component state, keyed by node at the mount site — they survive while you
 * work on an element and are gone when you select another one.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag, PageNode } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { Section } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import sectionStyles from '@ui/components/Section/Section.module.css'
import {
  collectNodeCssDeclarations,
  exportFormatLabel,
  exportRowLabel,
  exportScaleLabel,
  formatNodeCss,
  NODE_EXPORT_MENU,
  type NodeExportMenuEntry,
  type NodeExportRow,
} from './nodeExportModel'
import { copyTextToClipboard, downloadNodePng, downloadNodeSvg, readNodeJsxSource } from './nodeExportClient'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './ExportSection.module.css'

interface ExportSectionProps {
  nodeId: string
  pageId: string
  /** The selected node — read for its label, and for the SVG decision (`props.svg` / `props.src`). */
  node: PageNode
  /** Every curated property, in the order the copied rule should list them. */
  properties: ReadonlyArray<keyof CSSPropertyBag | string>
  /** Track F1's per-property winner map — the source of "Copy CSS". */
  provenanceByProperty: ReadonlyMap<string, PropertyProvenance>
  /** The node's class selectors (`.card`, `.is-active`), in `classIds` order. Empty for an unclassed element. */
  classSelectors: ReadonlyArray<string>
}

export function ExportSection({
  nodeId,
  pageId,
  node,
  properties,
  provenanceByProperty,
  classSelectors,
}: ExportSectionProps) {
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
    if (entry.action.kind === 'copy-css') {
      void copyCss()
      return
    }
    void copyJsx()
  }

  async function copyCss() {
    const declarations = collectNodeCssDeclarations(properties, provenanceByProperty)
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
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )

  // Law 1's rest state: no export configured, so one header line and the "+".
  if (rows.length === 0) {
    return <Section title="Export" icon={ArrowBarDownIcon} defaultOpen={false} flush children={null} actions={addButton} />
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
      defaultOpen
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
