/**
 * PrototypePanel — the inspector, while the board is in prototype mode.
 *
 * `STUDIO-PROTOTYPE-PLAN.md` §5: the right panel's BODY swaps in prototype
 * mode, the way Figma's Design/Prototype tabs do. It is not a third tab beside
 * Properties and Comments — those two are panels you choose between, and this
 * is the same panel showing a different layer of the same selection.
 *
 * TWO ENTRY POINTS, ONE FORM
 * ──────────────────────────
 * A link can be reached two ways, and the panel has to answer both:
 *
 *   - by SELECTING THE ELEMENT it starts from — the ordinary case, and the one
 *     that also authors a link where there is none yet;
 *   - by CLICKING THE CONNECTOR on the board (`selectedLinkId`), which is how
 *     you reach a link whose source element is off-screen, or gone.
 *
 * The second wins when both are live: the user just clicked a specific line,
 * and showing the properties of some other element instead would be answering
 * a question nobody asked. Editing goes through `updateLink` there, not
 * `saveLink`, because that link already carries its own anchor — re-capturing
 * a hint from the canvas selection would silently re-anchor it.
 *
 * Three sections otherwise, in the order the questions get asked:
 *
 *   - INTERACTION — the link on the selected element, editable. This is the
 *     design layer: it lives in `.studio/prototype.json` and is never written
 *     into the user's `.tsx`.
 *   - LEAVING THIS SCREEN — every authored link out of this page, so the panel
 *     answers "what does this screen do" without the user hunting a connector
 *     first. A broken link is listed, never hidden.
 *   - IN CODE — every flow Studio read out of THIS page's source. Read-only,
 *     because the only way to change one is to change the code, and shown
 *     underneath the editable half on purpose: an author about to invent a flow
 *     should be able to see the ones that already exist.
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
import { findLink, linkSource } from '@site/store/slices/prototypeSelectors'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { deleteLink, saveLink, updateLink } from '@site/studio/prototypeActions'
import styles from './PrototypePanel.module.css'

const ACTION_OPTIONS: ReadonlyArray<{ value: PrototypeAction; label: string }> = [
  { value: 'navigate', label: 'Navigate to' },
  { value: 'overlay', label: 'Open overlay' },
  { value: 'back', label: 'Go back' },
  { value: 'close', label: 'Close overlay' },
]

const ACTION_LABELS: Readonly<Record<PrototypeAction, string>> = {
  navigate: 'Navigate to',
  overlay: 'Open over',
  back: 'Go back',
  close: 'Close overlay',
}

const TRANSITION_LABELS: Readonly<Record<PrototypeTransition, string>> = {
  instant: 'Instant',
  dissolve: 'Dissolve',
  'slide-left': 'Slide left',
  'slide-right': 'Slide right',
  'push-left': 'Push left',
  'push-right': 'Push right',
  popup: 'Popup',
  sheet: 'Bottom sheet',
}

type Page = NonNullable<ReturnType<typeof selectActivePage>>
type PageOption = { value: string; label: string }

export function PrototypePanel() {
  const setBoardMode = useEditorStore((s) => s.setBoardMode)
  const page = useEditorStore(selectActivePage)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const links = useEditorStore((s) => s.prototype.links)
  const selectedLinkId = useEditorStore((s) => s.selectedLinkId)
  const codeEdges = useEditorStore((s) => s.codeFlow.edges)
  const pages = useEditorStore((s) => s.site?.pages)

  // Every store read above is a STABLE reference; the derived values are built
  // here in the render body, never inside `useEditorStore` — see
  // `prototypeSelectors`' module doc for the render loop that costs.
  const selectedLink = findLink(links, selectedLinkId)
  const pageOptions: PageOption[] = (pages ?? []).map((p) => ({ value: p.id, label: p.title }))

  return (
    <section className={styles.panel} data-testid="prototype-panel">
      <PanelHeader title="Prototype" panelId="prototype" onClose={() => setBoardMode('design')} />

      {selectedLink ? (
        <LinkInspector
          link={selectedLink}
          pageOptions={pageOptions}
          live={linkSource(selectedLink, pages).live}
        />
      ) : page ? (
        <>
          <InteractionSection
            page={page}
            selectedNodeId={selectedNodeId}
            links={links}
            pageOptions={pageOptions}
          />
          <OutgoingLinksSection page={page} links={links} pageOptions={pageOptions} pages={pages} />
          <CodeFlowSection pageId={page.id} edges={codeEdges} pageTitles={pages} />
        </>
      ) : (
        <EmptyState title="No page open" description="Open a page to work on its flows." />
      )}
    </section>
  )
}

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
  pageOptions: PageOption[]
}) {
  const requestLinkFromNode = useEditorStore((s) => s.requestLinkFromNode)
  const picking = useEditorStore((s) => s.linkDraft?.mode === 'pick' || s.pendingLinkSource !== null)

  if (!selectedNodeId) {
    return (
      <EmptyState
        icon={<LinkIcon size={16} />}
        title="Nothing selected"
        description="Select an element on the canvas, then drag its + handle onto another screen."
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

      {/* The same gesture the `+` handle beside the element starts, offered
          here too: the handle can only be drawn where the canvas can MEASURE
          the node, and "we could not measure it" is not an answer to give
          someone who has already selected the thing. */}
      {takesTarget && (
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={picking}
          onClick={() => requestLinkFromNode({ pageId: page.id, nodeId: selectedNodeId })}
          data-testid="prototype-pick-target"
        >
          {picking ? 'Click a screen — Esc cancels' : 'Link to a screen…'}
        </Button>
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
 * Every authored link leaving this screen.
 *
 * Broken links are listed, never hidden. A link whose source element was
 * deleted is the visible cost of an edit; silently dropping it is how a
 * prototype rots without anyone noticing.
 */
function OutgoingLinksSection({
  page,
  links,
  pageOptions,
  pages,
}: {
  page: Page
  links: readonly PrototypeLink[]
  pageOptions: PageOption[]
  pages: readonly Page[] | undefined
}) {
  const setSelectedLink = useEditorStore((s) => s.setSelectedLink)
  const outgoing = links.filter((link) => link.source.pageId === page.id)
  if (outgoing.length === 0) return null

  const titleOf = (id: string | null) =>
    id === null ? '—' : (pageOptions.find((option) => option.value === id)?.label ?? 'Deleted page')

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Leaving this screen</h3>
      <ul className={styles.list} data-testid="prototype-link-list">
        {outgoing.map((link) => {
          const live = linkSource(link, pages).live
          return (
            <li key={link.id}>
              <Button
                variant="secondary"
                size="sm"
                className={styles.row}
                onClick={() => setSelectedLink(link.id)}
                data-broken={live ? undefined : 'true'}
              >
                <span className={styles.rowAction}>{ACTION_LABELS[link.action]}</span>
                <span className={styles.rowTarget}>{titleOf(link.targetPageId)}</span>
                {!live && <span className={styles.rowBroken}>Source element is gone</span>}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * One link, reached by clicking its connector on the board.
 *
 * Every control writes the WHOLE link through `updateLink`. Changing the action
 * can strand the transition — `sheet` is meaningless once the link navigates —
 * so the legal one is re-derived here rather than storing an illegal pair and
 * relying on the reader to repair it.
 */
function LinkInspector({
  link,
  pageOptions,
  live,
}: {
  link: PrototypeLink
  pageOptions: PageOption[]
  /** Whether the source element still resolves. Computed by the parent. */
  live: boolean
}) {
  const setSelectedLink = useEditorStore((s) => s.setSelectedLink)
  const transitions = transitionsForAction(link.action)

  const changeAction = (action: PrototypeAction) => {
    const legal = transitionsForAction(action)
    const keeps = legal.find((t) => t === link.transition)
    void updateLink({
      ...link,
      action,
      targetPageId: actionTakesTarget(action) ? link.targetPageId : null,
      ...(legal.length > 0 ? { transition: keeps ?? legal[0] } : { transition: undefined }),
    })
  }

  return (
    <div className={styles.section} data-testid="prototype-link-inspector">
      {!live && (
        <p className={styles.warning} role="status">
          The element this link starts from no longer exists on the page.
        </p>
      )}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>On click</span>
        <Select
          fieldSize="sm"
          value={link.action}
          options={[...ACTION_OPTIONS]}
          onChange={(event) => changeAction(event.target.value as PrototypeAction)}
          aria-label="Interaction action"
        />
      </label>

      {actionTakesTarget(link.action) && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Screen</span>
          <Select
            fieldSize="sm"
            value={link.targetPageId ?? ''}
            placeholder="Choose a screen…"
            options={pageOptions}
            onChange={(event) => void updateLink({ ...link, targetPageId: event.target.value })}
            aria-label="Destination screen"
          />
        </label>
      )}

      {transitions.length > 0 && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Animation</span>
          <Select
            fieldSize="sm"
            value={link.transition ?? transitions[0]}
            options={transitions.map((t) => ({ value: t, label: TRANSITION_LABELS[t] }))}
            onChange={(event) =>
              void updateLink({ ...link, transition: event.target.value as PrototypeTransition })
            }
            aria-label="Transition"
          />
        </label>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={() => setSelectedLink(null)}>
          Done
        </Button>
        <Button variant="ghost" size="sm" tone="danger" onClick={() => void deleteLink(link.id)}>
          Delete link
        </Button>
      </div>
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
