/**
 * AttributesSection — Studio's own "Attributes" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras). Migrated (renamed from
 * `panels/PropertiesPanel/HtmlAttributesPanel.tsx`) onto its own
 * `INSPECTOR_SECTIONS` manifest entry, order 11, `appliesTo: any selected
 * node`. It used to live behind a separate Styles/Attributes tab switcher
 * (`PropertiesPanelBody.tsx`'s deleted `activeNodeView`) — it now renders
 * inline, in the same continuous scroll as every other section.
 *
 * Reads/writes through `useSelectionModel()`/`useInspectorCommit(model)`,
 * the same pattern every other migrated section uses: `htmlAttributes` is
 * an ordinary node prop, so a write is `commit.commitProp('htmlAttributes',
 * …)` — exactly `commitProp`'s documented job (routes to `updateNodeProps`,
 * or `setBreakpointOverride` when applicable) — not a direct
 * `useEditorStore((s) => s.updateNodeProps)` call the way the pre-migration
 * file made it.
 *
 * `readOnly` (`!permissions.canEditStructure ||
 * !isPropWritableToSource(selectedNode, 'htmlAttributes')`) used to be
 * computed by `PropertiesPanelBody.tsx` and threaded down as a prop; this
 * section now computes it itself from the two hooks every migrated section
 * already reads, the same way every other section owns every fact about its
 * own body.
 *
 * The inner editor (`HtmlAttributesPanelEditor`/`HtmlAttributeRow`) and
 * `htmlAttributesModel.ts` (kept in place, unchanged) are unchanged from the
 * pre-migration file — only the outer wiring and the `Section` wrapper are
 * new; the `.module.css` classes moved with the file (`git mv`) and keep
 * their old names.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { isPropWritableToSource } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { EmptyState } from '@ui/components/EmptyState'
import { Section } from '@ui/components/Section'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import {
  htmlAttributeRowsFromValue,
  htmlAttributesKey,
  htmlAttributesValueKey,
  validateHtmlAttributeRows,
  type HtmlAttributeDraftRow,
} from '../../panels/PropertiesPanel/htmlAttributesModel'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import styles from './AttributesSection.module.css'

export function AttributesSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const permissions = useEditorPermissions()
  const { selectedNodeId, selectedNode } = model

  if (!selectedNodeId || !selectedNode) return null

  const readOnly =
    !permissions.canEditStructure || !isPropWritableToSource(selectedNode, 'htmlAttributes')

  return (
    <Section title="Attributes" icon={CodeIcon} forceOpen flush>
      <HtmlAttributesPanelEditor
        key={selectedNodeId}
        nodeId={selectedNodeId}
        htmlAttributes={selectedNode.props.htmlAttributes}
        readOnly={readOnly}
        onCommit={(attributes) => commit.commitProp('htmlAttributes', attributes)}
      />
    </Section>
  )
}

interface HtmlAttributesPanelEditorProps {
  nodeId: string
  htmlAttributes: unknown
  readOnly: boolean
  onCommit: (attributes: Record<string, string>) => void
}

function HtmlAttributesPanelEditor({
  nodeId,
  htmlAttributes,
  readOnly,
  onCommit,
}: HtmlAttributesPanelEditorProps) {
  const externalAttributesKey = htmlAttributesValueKey(htmlAttributes)
  const syncedNodeId = useRef(nodeId)
  const syncedAttributesKey = useRef(externalAttributesKey)
  const nextRowId = useRef(0)
  const [rows, setRows] = useState<HtmlAttributeDraftRow[]>(() =>
    htmlAttributeRowsFromValue(htmlAttributes)
  )

  useEffect(() => {
    if (
      syncedNodeId.current === nodeId &&
      syncedAttributesKey.current === externalAttributesKey
    ) {
      return
    }

    syncedNodeId.current = nodeId
    syncedAttributesKey.current = externalAttributesKey
    setRows(htmlAttributeRowsFromValue(htmlAttributes))
  }, [externalAttributesKey, htmlAttributes, nodeId])

  const validation = validateHtmlAttributeRows(rows)
  const hasRows = rows.length > 0

  function persistRows(nextRows: HtmlAttributeDraftRow[]) {
    const nextValidation = validateHtmlAttributeRows(nextRows)
    if (Object.keys(nextValidation.errors).length > 0) return
    const nextAttributesKey = htmlAttributesKey(nextValidation.attributes)
    if (nextAttributesKey === syncedAttributesKey.current) return
    syncedAttributesKey.current = nextAttributesKey
    onCommit(nextValidation.attributes)
  }

  function updateRow(id: string, patch: Partial<Omit<HtmlAttributeDraftRow, 'id'>>) {
    const nextRows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
    setRows(nextRows)
    persistRows(nextRows)
  }

  function addRow() {
    nextRowId.current += 1
    setRows((current) => [
      { id: `new-${nextRowId.current}`, name: '', value: '' },
      ...current,
    ])
  }

  function removeRow(id: string) {
    const nextRows = rows.filter((row) => row.id !== id)
    setRows(nextRows)
    persistRows(nextRows)
  }

  return (
    <div className={styles.panel} data-testid="html-attributes-panel">
      <div className={styles.scroll}>
        <div className={styles.header}>
          <Button
            variant="secondary"
            size="xs"
            aria-label="Add attribute"
            onClick={addRow}
            disabled={readOnly}
          >
            <PlusIcon size={13} aria-hidden="true" />
            Add
          </Button>
        </div>

        {hasRows ? (
          <div className={styles.rows} role="list" aria-label="HTML attributes">
            {rows.map((row) => (
              <HtmlAttributeRow
                key={row.id}
                row={row}
                error={validation.errors[row.id]}
                readOnly={readOnly}
                onChange={updateRow}
                onRemove={removeRow}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <EmptyState variant="centered" title="No attributes set" />
          </div>
        )}
      </div>
    </div>
  )
}

interface HtmlAttributeRowProps {
  row: HtmlAttributeDraftRow
  error?: string
  readOnly: boolean
  onChange: (id: string, patch: Partial<Omit<HtmlAttributeDraftRow, 'id'>>) => void
  onRemove: (id: string) => void
}

function HtmlAttributeRow({
  row,
  error,
  readOnly,
  onChange,
  onRemove,
}: HtmlAttributeRowProps) {
  const errorId = `${row.id}-attribute-error`

  return (
    <div className={styles.row} role="listitem" data-invalid={error ? 'true' : undefined}>
      <div className={styles.rowGrid}>
        <Input
          fieldSize="sm"
          monospace
          value={row.name}
          placeholder="id, aria-label, data-name"
          aria-label="Attribute name"
          aria-describedby={error ? errorId : undefined}
          invalid={Boolean(error)}
          disabled={readOnly}
          spellCheck={false}
          onChange={(event) => onChange(row.id, { name: event.target.value })}
        />
        <Input
          fieldSize="sm"
          monospace
          value={row.value}
          placeholder="value"
          aria-label={`${row.name || 'Attribute'} value`}
          disabled={readOnly}
          spellCheck={false}
          onChange={(event) => onChange(row.id, { value: event.target.value })}
        />
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Remove ${row.name || 'attribute'}`}
          tooltip="Remove attribute"
          onClick={() => onRemove(row.id)}
          disabled={readOnly}
        >
          <TrashSolidIcon size={12} aria-hidden="true" />
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}
