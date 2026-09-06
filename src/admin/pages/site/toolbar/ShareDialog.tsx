/**
 * ShareDialog — create, update, copy and revoke this project's share links.
 *
 * ## The one thing this dialog has to be honest about
 *
 * A share is a SNAPSHOT. v1 photographs the board when you press the button
 * and serves those pictures until you press it again; it is not a live view.
 * A reviewer who assumes otherwise reviews the wrong thing, so every row says
 * when it was captured and the primary action for an existing link is called
 * "Update" rather than something that implies it was already current.
 *
 * ## Why creating one is slow
 *
 * "Share current board" drives a real headless render of every frame on the
 * board (the same machinery `studio_compare` uses). On a large board that is
 * seconds, not milliseconds, so the button holds `Button`'s `loading` state
 * for the whole round trip and the dialog says what is happening rather than
 * appearing to have ignored the click.
 */
import { useEffect, useState } from 'react'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { isAbortError } from '@core/http'
import type { ShareSummary } from '@core/studio-share'
import { absoluteShareUrl, createShare, listShares, revokeShare } from '@site/studio/shareLinks'
import { useEditorStore } from '@site/store/store'
import styles from './ShareDialog.module.css'

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const activeBoardId = useEditorStore((s) => s.activeBoardId)
  const [shares, setShares] = useState<ShareSummary[] | null>(null)
  /** The token currently being captured, `'new'` while minting, or null. */
  const [busyToken, setBusyToken] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        setShares(await listShares(controller.signal))
      } catch (err) {
        if (isAbortError(err)) return
        console.error('[ShareDialog] could not list shares:', err)
        setShares([])
        pushToast({
          kind: 'error',
          title: 'Could not load shares',
          body: getErrorMessage(err, 'Unknown error reading this project’s share links'),
        })
      }
    })()
    return () => controller.abort()
  }, [])

  async function copyLink(token: string) {
    const url = absoluteShareUrl(`/share/${token}`)
    try {
      await navigator.clipboard.writeText(url)
      pushToast({ kind: 'success', title: 'Link copied', body: url })
    } catch (err) {
      console.error('[ShareDialog] clipboard write failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not copy the link',
        body: `Copy it by hand: ${url}`,
      })
    }
  }

  async function capture(token?: string) {
    setBusyToken(token ?? 'new')
    try {
      const result = await createShare(activeBoardId, token)
      setShares(result.shares)
      if (!token) {
        await copyLink(result.share.token)
      } else {
        pushToast({ kind: 'success', title: 'Share updated', body: 'The link now shows the current board.' })
      }
    } catch (err) {
      console.error('[ShareDialog] could not capture the board:', err)
      pushToast({
        kind: 'error',
        title: token ? 'Could not update the share' : 'Could not share this board',
        body: getErrorMessage(err, 'Unknown error photographing the board'),
      })
    } finally {
      setBusyToken(null)
    }
  }

  async function revoke(token: string) {
    setBusyToken(token)
    try {
      setShares(await revokeShare(token))
      pushToast({ kind: 'success', title: 'Share revoked', body: 'That link stops working immediately.' })
    } catch (err) {
      console.error('[ShareDialog] could not revoke the share:', err)
      pushToast({
        kind: 'error',
        title: 'Could not revoke the share',
        body: getErrorMessage(err, 'Unknown error revoking the share link'),
      })
    } finally {
      setBusyToken(null)
    }
  }

  const live = shares?.filter((share) => !share.revokedAt) ?? []
  const revoked = shares?.filter((share) => share.revokedAt) ?? []

  return (
    <Dialog
      open
      onClose={onClose}
      title="Share this board"
      eyebrow="Read-only link"
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="primary"
            loading={busyToken === 'new'}
            onClick={() => {
              void capture()
            }}
          >
            {busyToken === 'new' ? 'Photographing the board…' : 'Share current board'}
          </Button>
        </>
      }
    >
      <p className={styles.intro}>
        Anyone with the link sees a read-only picture of this board — frames, their
        layout, and their names. No sign-in, no editing, and no access to the code.
        A share is a snapshot: update it to re-capture, revoke it to turn it off.
      </p>

      {shares === null && <p className={styles.empty}>Loading…</p>}

      {shares !== null && live.length === 0 && (
        <p className={styles.empty}>
          No live links yet. “Share current board” photographs it and copies the link.
        </p>
      )}

      {live.length > 0 && (
        <ul className={styles.list}>
          {live.map((share) => (
            <li key={share.token} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.boardName}>{share.boardName}</span>
                <span className={styles.rowMeta}>
                  {share.frameCount} {share.frameCount === 1 ? 'screen' : 'screens'} · shared{' '}
                  {formatWhen(share.snapshotAt)}
                </span>
                <code className={styles.url}>{absoluteShareUrl(`/share/${share.token}`)}</code>
              </div>
              <div className={styles.rowActions}>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Copy link"
                  tooltip="Copy link"
                  onClick={() => {
                    void copyLink(share.token)
                  }}
                >
                  <CopySolidIcon size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Update snapshot"
                  tooltip="Re-capture the board — the link stays the same"
                  loading={busyToken === share.token}
                  onClick={() => {
                    void capture(share.token)
                  }}
                >
                  <ReloadIcon size={14} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Revoke link"
                  tooltip="Revoke — the link stops working immediately"
                  disabled={busyToken !== null}
                  onClick={() => {
                    void revoke(share.token)
                  }}
                >
                  <TrashSolidIcon size={14} aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 && (
        <details className={styles.revoked}>
          <summary className={styles.revokedSummary}>
            {revoked.length} revoked {revoked.length === 1 ? 'link' : 'links'}
          </summary>
          <ul className={styles.list}>
            {revoked.map((share) => (
              <li key={share.token} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.boardName}>{share.boardName}</span>
                  <span className={styles.rowMeta}>revoked {formatWhen(share.revokedAt ?? '')}</span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Dialog>
  )
}

/** A timestamp in the operator's own locale, or the raw value when it will not parse. */
function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
