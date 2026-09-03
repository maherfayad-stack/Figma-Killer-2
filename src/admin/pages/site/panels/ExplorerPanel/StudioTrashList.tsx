/**
 * StudioTrashList — the "Trash" section of the Studio explorer panel: pages
 * whose files have been moved into `.studio/trash/`, with Restore and Delete
 * permanently.
 *
 * **Renders nothing when the trash is empty.** A permanently-visible empty
 * Trash row would cost every project a line of chrome to tell it something it
 * already knows; the section appearing is itself the signal that something is
 * in there. It reappears the moment a page is trashed, because
 * `STUDIO_TRASH_CHANGED_EVENT` re-fetches.
 *
 * Server state is re-read, never mirrored (see `studioTrashRequests.ts`): the
 * list is small, only fetched while this section is mounted, and an agent turn
 * or a second tab can change `.studio/trash/` underneath the browser at any
 * time. Every action here re-fetches when it lands rather than patching a
 * local copy.
 *
 * Restoring reloads the workspace: the page's files are back in `pages/`, so
 * the board and every page list need to re-parse to see them. Purging does
 * not — nothing outside `.studio/` changed.
 */
import { useCallback, useEffect, useState } from 'react'
import { STUDIO_TRASH_CHANGED_EVENT, notifyStudioTrashChanged, requestCmsSiteReload } from '@admin/state/adminEvents'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { listStudioTrash, purgeStudioTrash, restoreStudioTrashEntry, type StudioTrashEntry } from '@site/studio/studioTrashRequests'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { cn } from '@ui/cn'
import styles from './StudioTrashList.module.css'

/** `2026-09-02T10:04:00.000Z` → `2 Sep`. The list is short and recent; a full timestamp would be noise. */
function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function StudioTrashList() {
  const [entries, setEntries] = useState<StudioTrashEntry[]>([])
  const [collapsed, setCollapsed] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const confirmDelete = useConfirmDelete()

  // `useCallback` (React Compiler exception #1): this is named in the effect's
  // dependency array below, which the static `react-hooks/exhaustive-deps`
  // rule cannot see the compiler's memoization through.
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setEntries(await listStudioTrash(signal))
    } catch (err) {
      if (isAbortError(err)) return
      // A trash that cannot be listed is not worth a toast on every mount —
      // the section simply stays hidden, exactly as it does when empty.
      console.error('[StudioTrashList] could not list the trash:', err)
    }
  }, [])

  // Initial read + subscription. `refresh` setStates (after an await, never
  // synchronously), which the React 19 lint rule cannot see through — same
  // shape and the same disable `useMediaWorkspace.ts` uses for its own
  // fetch-on-mount.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const onChanged = () => { void refresh() }
    window.addEventListener(STUDIO_TRASH_CHANGED_EVENT, onChanged)
    return () => {
      controller.abort()
      window.removeEventListener(STUDIO_TRASH_CHANGED_EVENT, onChanged)
    }
  }, [refresh])
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleRestore(entry: StudioTrashEntry) {
    setBusyId(entry.id)
    try {
      await restoreStudioTrashEntry(entry.id)
      notifyStudioTrashChanged()
      // The files are back under `pages/` — only a re-parse can show them.
      requestCmsSiteReload()
    } catch (err) {
      console.error('[StudioTrashList] restore failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not restore page',
        body: getErrorMessage(err, 'Unknown trash error'),
      })
    } finally {
      setBusyId(null)
    }
  }

  function handlePurge(entry: StudioTrashEntry) {
    confirmDelete({
      title: 'Delete permanently?',
      description: `"${entry.title}" will be removed from the trash and from disk. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      alwaysConfirm: true,
      commit: () => { void runPurge(entry.id) },
    })
  }

  function handleEmpty() {
    confirmDelete({
      title: 'Empty the trash?',
      description: `${entries.length} ${entries.length === 1 ? 'page' : 'pages'} will be removed from disk. This cannot be undone.`,
      confirmLabel: 'Empty trash',
      alwaysConfirm: true,
      commit: () => { void runPurge(undefined) },
    })
  }

  async function runPurge(entryId: string | undefined) {
    if (entryId) setBusyId(entryId)
    try {
      await purgeStudioTrash(entryId)
      notifyStudioTrashChanged()
    } catch (err) {
      console.error('[StudioTrashList] purge failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not empty the trash',
        body: getErrorMessage(err, 'Unknown trash error'),
      })
    } finally {
      setBusyId(null)
    }
  }

  if (entries.length === 0) return null

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        {/* Bare <button> (§8.17 in button-primitive-usage.test.ts): the same
            exact-typography disclosure `StudioBoardsList` uses — Button's
            token-driven padding does not fit this header rhythm. */}
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          <ChevronRightIcon
            size={10}
            aria-hidden="true"
            className={cn(styles.disclosureChevron, !collapsed && styles.disclosureChevronExpanded)}
          />
          <span className={styles.heading}>Trash ({entries.length})</span>
        </button>
        {!collapsed && (
          <Button variant="ghost" size="micro" onClick={handleEmpty}>
            Empty
          </Button>
        )}
      </div>
      {!collapsed && (
        <TreeContainer ariaLabel="Trash" testId="studio-trash-list" className={styles.list}>
          {entries.map((entry) => (
            <TreeRow key={entry.id} depth={0}>
              <TreeIconSlot>
                <TrashSolidIcon size={11} aria-hidden="true" />
              </TreeIconSlot>
              <TreeLabel>{entry.title}</TreeLabel>
              <span className={styles.deletedAt}>{shortDate(entry.deletedAt)}</span>
              <Button
                variant="ghost"
                size="micro"
                disabled={busyId === entry.id}
                onClick={() => { void handleRestore(entry) }}
              >
                Restore
              </Button>
              <Button
                variant="ghost"
                size="micro"
                disabled={busyId === entry.id}
                onClick={() => handlePurge(entry)}
              >
                Delete
              </Button>
            </TreeRow>
          ))}
        </TreeContainer>
      )}
    </div>
  )
}
