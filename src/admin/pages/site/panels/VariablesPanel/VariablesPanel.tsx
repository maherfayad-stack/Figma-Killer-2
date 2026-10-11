/**
 * VariablesPanel - the project's design tokens, as a table (CT-3).
 *
 * Rows are CSS custom properties read from the stylesheets the canvas loads,
 * grouped into collections (declaring file x leading name segment), with a
 * column per MODE the project's own gates define (`:root`, `[data-theme="dark"]`,
 * `.dark`, `@media (prefers-color-scheme: dark)`...) and a usage count. Nothing
 * is stored anywhere but the user's own CSS: an edit here is a formatting-
 * preserving change to one declaration (or, for a rename, to every mention),
 * written through the same planner `studio_set_tokens` uses.
 *
 * Open-panel contract: the catalog is read with usage when the panel opens and
 * whenever the project's stylesheets change; typing in a value cell previews on
 * the board, committing writes once and pushes one undo entry.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { Panel, useAutoFocusPanel } from '@admin/shared/Panel'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { ChevronDown2Icon } from 'pixel-art-icons/icons/chevron-down-2'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { getStudioAuthoredCss, getStudioVendorCss, subscribeStudioAuthoredCss, subscribeStudioVendorCss } from '@site/studio/studioRawCssStores'
import {
  applyStudioTokenEdits,
  getStudioTokenState,
  refreshStudioTokenCatalog,
  subscribeStudioTokenCatalog,
} from '@site/studio/studioTokenCatalog'
import { VariableRow, type VariableRowWrite } from './VariableRow'
import { buildColumns, buildVariableGroups, replacementCandidates } from './variablesModel'
import styles from './VariablesPanel.module.css'

interface VariablesPanelProps {
  variant?: 'docked'
}

export function VariablesPanel({ variant = 'docked' }: VariablesPanelProps) {
  const isOpen = useEditorStore((s) => s.variablesPanelOpen)
  const setVariablesPanelOpen = useEditorStore((s) => s.setVariablesPanelOpen)
  const undo = useEditorStore((s) => s.undo)
  const tokenState = useSyncExternalStore(subscribeStudioTokenCatalog, getStudioTokenState)
  const authoredCss = useSyncExternalStore(subscribeStudioAuthoredCss, getStudioAuthoredCss)
  const vendorCss = useSyncExternalStore(subscribeStudioVendorCss, getStudioVendorCss)
  const panelRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useAutoFocusPanel(panelRef, isOpen)

  // The usage scan is a project-wide read, so it runs only while the panel is
  // showing - on open, and again when the stylesheets it describes change.
  useEffect(() => {
    if (isOpen) void refreshStudioTokenCatalog({ usage: true })
  }, [isOpen, authoredCss, vendorCss])

  if (!isOpen || variant !== 'docked') return null

  const { catalog, usage } = tokenState

  async function write(request: VariableRowWrite): Promise<void> {
    setBusy(true)
    setStatus(null)
    try {
      const result = await applyStudioTokenEdits(request.edits, request.undoLabel)
      setStatus(request.summary({ renamed: result.renamed[0]?.mentions ?? 0, moved: result.removed[0]?.movedReaders ?? 0 }))
    } finally {
      setBusy(false)
    }
  }

  function toggleCollection(id: string) {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
  }

  const columns = catalog ? buildColumns(catalog) : []
  const groups = catalog ? buildVariableGroups(catalog, usage, columns, query) : []

  return (
    <Panel ref={panelRef} panelId="variables" title="Variables" testId="variables-panel" onClose={() => setVariablesPanelOpen(false)}>
      <SearchBar value={query} onValueChange={setQuery} placeholder="Search variables" aria-label="Search variables" />

      {status ? (
        <div className={styles.status} role="status">
          <span>{status}</span>
          <Button variant="ghost" size="xs" onClick={() => undo()}>
            Undo
          </Button>
        </div>
      ) : null}

      {catalog === null ? (
        <EmptyState compact plain title="Reading variables..." />
      ) : groups.length === 0 ? (
        <EmptyState
          compact
          plain
          title={query ? 'No variable matches.' : 'No CSS variables yet.'}
          description={query ? undefined : 'Declare custom properties in a stylesheet (for example :root { --color-brand: #0c9ab0 }) and they appear here.'}
        />
      ) : (
        <div className={styles.table} style={{ '--mode-count': columns.length } as CSSProperties}>
          <div className={styles.header} aria-hidden="true">
            <span>Name</span>
            {columns.map((column) => (
              <span key={column.id}>{column.label}</span>
            ))}
            <span />
          </div>
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.collection.id)
            return (
              <section key={group.collection.id} className={styles.group} aria-label={group.collection.label}>
                <Button
                  variant="ghost"
                  size="xs"
                  align="start"
                  fullWidth
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollection(group.collection.id)}
                >
                  {isCollapsed ? <ChevronRightIcon size={10} aria-hidden="true" /> : <ChevronDown2Icon size={10} aria-hidden="true" />}
                  <span className={styles.groupLabel}>{group.collection.label}</span>
                  <span className={styles.groupFile}>{group.collection.file}</span>
                  <span className={styles.groupCount}>{group.rows.length}</span>
                </Button>
                {isCollapsed ? null : (
                  <ul className={styles.rows}>
                    {group.rows.map((row) => (
                      <VariableRow
                        key={row.token.name}
                        row={row}
                        replacements={catalog ? replacementCandidates(catalog, row.token) : []}
                        busy={busy}
                        onWrite={write}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
