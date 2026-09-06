/**
 * PrototypePanel — the inspector, while the board is in prototype mode.
 *
 * `STUDIO-PROTOTYPE-PLAN.md` §5: the right panel's BODY swaps in prototype
 * mode, the way Figma's Design/Prototype tabs do. It is not a third tab beside
 * Properties and Comments — those two are panels you choose between, and this
 * is the same panel showing a different layer of the same selection.
 *
 * Two halves, and the difference between them is the feature:
 *
 *   - INTERACTION — the link on the selected element, editable. This is the
 *     design layer: it lives in `.studio/prototype.json` and is never written
 *     into the user's `.tsx`.
 *   - IN CODE — every flow Studio read out of THIS page's source. Read-only,
 *     because the only way to change one is to change the code, and shown
 *     right underneath the editable half on purpose: an author about to
 *     invent a flow should be able to see the ones that already exist.
 *
 * WHY EVERY CONTROL SAVES ON CHANGE
 * ─────────────────────────────────
 * There is no Apply button. A link is three enum choices, each one a complete
 * statement on its own, and the server merges op-by-op — so a form-and-submit
 * would add a state ("edited but not saved") that has no meaning here and one
 * more way to lose work by clicking away. Same posture `commentActions` takes:
 * write through immediately, adopt the server's merged file.
 */
import { useEditorStore, selectActivePage } from '@site/store/store'
import {
  actionTakesTarget,
  linksFromPage,
  resolveLinkSource,
  transitionsForAction,
  type PrototypeAction,
  type PrototypeLink,
  type PrototypeTransition,
} from '@core/studio-prototype'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { deleteLink, saveLink } from '@site/studio/prototypeActions'
import styles from './PrototypePanel.module.css'

const ACTION_OPTIONS: ReadonlyArray<{ value: PrototypeAction; label: string }> = [
  { value: 'navigate', label: 'Navigate to' },
  { value: 'overlay', label: 'Open overlay' },
  { value: 'back', label: 'Go back' },
  { value: 'close', label: 'Close overlay' },
]

const TRANSITION_LABELS: Readonly<Record<PrototypeTransition, string>> = {
  instant: 'Instant',
  dissolve: 'Dissolve',
  'slide-left': 'Slide left',
  'slide-right': 'Slide right',
  'push-left': 'Push left',
  'push-right': 'Push right',
  popup: 'Popup',
  sheet: 'Sheet',
}

export function PrototypePanel() {
  const setBoardMode = useEditorStore((s) => s.setBoardMode)
  const page = useEditorStore(selectActivePage)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const links = useEditorStore((s) => s.prototype.links)
  const codeEdges = useEditorStore((s) => s.codeFlow.edges)
  const pages = useEditorStore((s) => s.site?.pages)

  return (
    <section className={styles.panel} data-testid="prototype-panel">
      <PanelHeader title="Prototype" panelId="prototype" onClose={() => setBoardMode('design')} />

      {page ? (
        <>
          <InteractionSection
            page={page}
            selectedNodeId={selectedNodeId}
            links={links}
            pageOptions={(pages ?? []).map((p) => ({ value: p.id, label: p.title }))}
          />
          <CodeFlowSection pageId={page.id} edges={codeEdges} pageTitles={pages} />
        </>
      ) : (
        <EmptyState title="No page open" description="Open a page to work on its flows." />
      )}
    </section>
  )
}

type Page = NonNullable<ReturnType<typeof selectActivePage>>

/**
 * The link on the selected element.
 *
 * The link is found by RE-RESOLVING every link on this page against the live
 * tree and matching the resolved node id — never by comparing the stored
 * `nodeId`, which is a source position and rots on nearly every edit above the
 * element (`@core/studio-anchor`). Matching on the stored id would make a link
 * disappear from the inspector the moment the user added a line above it, and
 * the next edit would silently author a second link on the same element.
 */
function InteractionSection({
  page,
  selectedNodeId,
  links,
  pageOptions,
}: {
  page: Page
  selectedNodeId: string | null
  links: readonly PrototypeLink[]
  pageOptions: { value: string; label: string }[]
}) {
  if (!selectedNodeId) {
    return (
      <EmptyState
        title="Nothing selected"
        description="Select an element on the canvas to give it a link."
        data-testid="prototype-panel-no-selection"
      />
    )
  }

  const existing = linksFromPage({ version: 1, links: [...links] }, page.id).find(
    (link) => resolveLinkSource(link.source.node, page).nodeId === selectedNodeId,
  )

  const action = existing?.action ?? 'navigate'
  const transitions = transitionsForAction(action)
  const takesTarget = actionTakesTarget(action)
  // Only the target page is missing when nothing has been authored yet, so a
  // fresh element opens on `navigate` with the target as the one open question.
  const targetPageId = existing?.targetPageId ?? ''

  const commit = (next: {
    action?: PrototypeAction
    targetPageId?: string | null
    transition?: PrototypeTransition
  }) => {
    void saveLink(
      {
        ...(existing ? { id: existing.id } : {}),
        pageId: page.id,
        nodeId: selectedNodeId,
        action: next.action ?? action,
        targetPageId: next.targetPageId ?? targetPageId,
        transition: next.transition ?? existing?.transition,
      },
      page,
    )
  }

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>On click</h3>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Action</span>
        <Select
          fieldSize="sm"
          value={action}
          options={[...ACTION_OPTIONS]}
          onChange={(event) => commit({ action: event.target.value as PrototypeAction })}
          aria-label="Interaction action"
          data-testid="prototype-action-select"
        />
      </label>

      {takesTarget && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Destination</span>
          <Select
            fieldSize="sm"
            value={targetPageId}
            placeholder="Choose a screen…"
            options={pageOptions}
            onChange={(event) => commit({ targetPageId: event.target.value })}
            aria-label="Destination screen"
            data-testid="prototype-target-select"
          />
        </label>
      )}

      {transitions.length > 0 && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Animation</span>
          <Select
            fieldSize="sm"
            value={existing?.transition ?? transitions[0]}
            options={transitions.map((t) => ({ value: t, label: TRANSITION_LABELS[t] }))}
            onChange={(event) => commit({ transition: event.target.value as PrototypeTransition })}
            aria-label="Transition"
            data-testid="prototype-transition-select"
          />
        </label>
      )}

      {existing && (
        <Button
          variant="ghost"
          size="sm"
          tone="danger"
          onClick={() => void deleteLink(existing.id)}
          data-testid="prototype-remove-link"
        >
          Remove link
        </Button>
      )}
    </div>
  )
}

/**
 * The flows already written in this page's code. Read-only, and it says so —
 * there is no control here at all, only the evidence and where it lives.
 */
function CodeFlowSection({
  pageId,
  edges,
  pageTitles,
}: {
  pageId: string
  edges: readonly { id: string; sourcePageId: string; targetPageId: string; evidence: string }[]
  pageTitles: readonly { id: string; title: string }[] | undefined
}) {
  const outgoing = edges.filter((edge) => edge.sourcePageId === pageId)
  const titleOf = (id: string) => pageTitles?.find((p) => p.id === id)?.title ?? id

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Already in the code</h3>
      {outgoing.length === 0 ? (
        <p className={styles.note}>Studio found no navigation out of this screen&rsquo;s source.</p>
      ) : (
        <ul className={styles.codeList} data-testid="prototype-code-flows">
          {outgoing.map((edge) => (
            <li key={edge.id} className={styles.codeRow}>
              <span className={styles.codeTarget}>{titleOf(edge.targetPageId)}</span>
              <code className={styles.codeEvidence}>{edge.evidence}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
