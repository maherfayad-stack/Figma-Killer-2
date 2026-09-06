/**
 * The one failure state a viewer ever sees.
 *
 * Every reason a share can fail — malformed token, no such share, revoked
 * share, deleted project, a snapshot whose files went missing — collapses to
 * this. That is the same choice `sharePublic.ts` makes server-side and for
 * the same reason: telling a stranger WHICH of those happened tells them
 * whether a token was ever real. The copy is written for the far more likely
 * reader, a reviewer holding a link that has since been turned off.
 */
import styles from './ShareViewer.module.css'

export function ShareUnavailable() {
  return (
    <main className={styles.unavailable}>
      <h1 className={styles.unavailableTitle}>This link is no longer available</h1>
      <p className={styles.unavailableBody}>
        The share may have been revoked, or the address may be incomplete. Ask whoever
        sent it for a new link.
      </p>
    </main>
  )
}
