/**
 * PrototypePanel — the inspector while the board is in prototype mode.
 *
 * It REPLACES the Properties panel rather than joining it as a third tab, the
 * way Figma's Design/Prototype tabs do. In prototype mode the user is not
 * editing styles, and leaving a full style inspector on screen invites edits
 * they did not mean to make with a gesture that now means something else.
 *
 * Two states, and the empty one is the more important:
 *
 *   - A link is selected → its properties, and nothing else.
 *   - Nothing is selected → the flows leaving the selected page, so the panel
 *     answers "what does this screen do" without requiring the user to hunt a
 *     connector line first.
 *
 * Broken links are listed, never hidden. A link whose source element was
 * deleted is the visible cost of an edit; silently dropping it is how a
 * prototype rots without anyone noticing.
 */
import { useEditorStore } from '@site/store/store'
import { findLink, linkSource, visibleLinks } from '@site/store/slices/prototypeSelectors'
import { transitionsForAction, type PrototypeAction, type PrototypeLink, type PrototypeTransition } from '@core/studio-prototype'
import { deleteLink, updateLink } from '@site/studio/prototypeActions'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import styles from './PrototypePanel.module.css'

const ACTION_LABELS: Record<PrototypeAction, string> = {
  navigate: 'Navigate to',
  overlay: 'Open over',
  back: 'Go back',
  close: 'Close overlay',
}

const TRANSITION_LABELS: Record<PrototypeTransition, string> = {
  instant: 'Instant',
  dissolve: 'Dissolve',
  'slide-left': 'Slide left',
  'slide-right': 'Slide right',
  'push-left': 'Push left',
  'push-right': 'Push right',
  popup: 'Popup',
  sheet: 'Bottom sheet',
}

export function PrototypePanel() {
  const setBoardMode = useEditorStore((s) => s.setBoardMode)
  const authoredLinks = useEditorStore((s) => s.prototype.links)
  const selectedLinkId = useEditorStore((s) => s.selectedLinkId)
  const pages = useEditorStore((s) => s.site?.pages)
  const setSelectedLink = useEditorStore((s) => s.setSelectedLink)

  // Every store read above is a STABLE reference; the derived values are built
  // here, never inside `useEditorStore`. A selector that builds a fresh array
  // or object loops forever — see `prototypeSelectors`' module doc.
  const links = visibleLinks(authoredLinks, pages)
  const selected = findLink(links, selectedLinkId)

  const pageName = (pageId: string | null): string => {
    if (!pageId) return '—'
    return pages?.find((p) => p.id === pageId)?.title ?? 'Deleted page'
  }

  return (
    <div className={styles.panel}>
      <PanelHeader title="Prototype" panelId="prototype" onClose={() => setBoardMode('design')} />

      {selected ? (
        <LinkInspector link={selected} pageOptions={pages ?? []} live={linkSource(selected, pages).live} />
      ) : (
        <div className={styles.body}>
          {links.length === 0 ? (
            <EmptyState
              icon={<LinkIcon size={16} />}
              title="No links yet."
              description="Drag from an element's + handle onto another screen to connect them."
            />
          ) : (
            <ul className={styles.list}>
              {links.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  label={pageName(link.targetPageId)}
                  live={linkSource(link, pages).live}
                  onSelect={setSelectedLink}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function LinkRow({
  link,
  label,
  live,
  onSelect,
}: {
  link: PrototypeLink
  label: string
  /** Whether the source element still resolves. Computed by the parent. */
  live: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <Button
        variant="secondary"
        size="sm"
        className={styles.row}
        onClick={() => onSelect(link.id)}
        data-broken={live ? undefined : 'true'}
      >
        <span className={styles.rowAction}>
          {ACTION_LABELS[link.action]}
          {link.origin === 'code' && <span className={styles.rowFromCode}>from code</span>}
        </span>
        <span className={styles.rowTarget}>{label}</span>
        {!live && <span className={styles.rowBroken}>Source element is gone</span>}
      </Button>
    </li>
  )
}

function LinkInspector({
  link,
  pageOptions,
  live,
}: {
  link: PrototypeLink
  pageOptions: ReadonlyArray<{ id: string; title: string }>
  /** Whether the source element still resolves. Computed by the parent. */
  live: boolean
}) {
  const setSelectedLink = useEditorStore((s) => s.setSelectedLink)
  const transitions = transitionsForAction(link.action)

  /**
   * Changing the action can strand the transition — `sheet` is meaningless once
   * the link navigates. Re-derive it here rather than storing an illegal pair
   * and relying on the reader to repair it.
   */
  const changeAction = (action: PrototypeAction) => {
    const legal = transitionsForAction(action)
    void updateLink({
      ...link,
      action,
      targetPageId: action === 'back' || action === 'close' ? null : link.targetPageId,
      ...(legal.length > 0
        ? { transition: legal.includes(link.transition as PrototypeTransition) ? link.transition : legal[0] }
        : { transition: undefined }),
    })
  }

  /**
   * A derived link is a READING of the user's source, not a thing on the board.
   * Editing it here would either lie (the board would disagree with the code) or
   * require Studio to rewrite a handler it cannot honestly rewrite. So the
   * inspector explains it instead, which is the answer the user actually wants
   * when they click a connector they did not draw.
   */
  if (link.origin === 'code') {
    return (
      <div className={styles.body}>
        <p className={styles.warning} role="status">
          This connector was read out of your code, not drawn on the board. Change the handler in
          the source to change where it goes.
        </p>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Navigates to</span>
          <span className={styles.rowTarget}>
            {pageOptions.find((page) => page.id === link.targetPageId)?.title ?? 'Deleted page'}
          </span>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setSelectedLink(null)}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.body}>
      {!live && (
        <p className={styles.warning} role="status">
          The element this link starts from no longer exists on the page.
        </p>
      )}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>On click</span>
        <Select value={link.action} onChange={(e) => changeAction(e.target.value as PrototypeAction)}>
          {(Object.keys(ACTION_LABELS) as PrototypeAction[]).map((action) => (
            <option key={action} value={action}>
              {ACTION_LABELS[action]}
            </option>
          ))}
        </Select>
      </label>

      {link.targetPageId !== null && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Screen</span>
          <Select
            value={link.targetPageId}
            onChange={(e) => void updateLink({ ...link, targetPageId: e.target.value })}
          >
            {pageOptions.map((page) => (
              <option key={page.id} value={page.id}>
                {page.title}
              </option>
            ))}
          </Select>
        </label>
      )}

      {transitions.length > 0 && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Animation</span>
          <Select
            value={link.transition ?? transitions[0]}
            onChange={(e) => void updateLink({ ...link, transition: e.target.value as PrototypeTransition })}
          >
            {transitions.map((transition) => (
              <option key={transition} value={transition}>
                {TRANSITION_LABELS[transition]}
              </option>
            ))}
          </Select>
        </label>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => setSelectedLink(null)}>
          Done
        </Button>
        <Button variant="destructive" onClick={() => void deleteLink(link.id)}>
          Delete link
        </Button>
      </div>
    </div>
  )
}
