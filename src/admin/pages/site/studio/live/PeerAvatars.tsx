/**
 * PeerAvatars - who else is on this board, in the toolbar.
 *
 * One avatar per PERSON (two tabs of one user are one avatar), ringed in their
 * identity colour. Clicking an avatar follows that person's view; clicking it
 * again, or panning/zooming yourself, stops. While the channel is down the row
 * says so instead of silently showing nobody.
 */
import type { CSSProperties } from 'react'
import { UserAvatar } from '@admin/shared/UserAvatar/UserAvatar'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { liveColorVar } from '@core/studio-live'
import { distinctPeers, useLivePresence } from './livePresenceStore'
import { toggleFollow } from './useLiveFollow'
import styles from './PeerAvatars.module.css'

const MAX_VISIBLE_AVATARS = 4

export function PeerAvatars() {
  const status = useLivePresence((s) => s.status)
  const members = useLivePresence((s) => s.members)
  const selfId = useLivePresence((s) => s.selfId)
  const followingId = useLivePresence((s) => s.followingId)

  if (status === 'reconnecting') {
    return (
      <span className={styles.status} role="status" data-testid="live-status">
        Reconnecting…
      </span>
    )
  }
  const peers = distinctPeers(members, selfId)
  if (status !== 'live' || peers.length === 0) return null

  const visible = peers.slice(0, MAX_VISIBLE_AVATARS)
  const hidden = peers.length - visible.length
  return (
    <div className={styles.stack} role="group" aria-label="People on this board" data-testid="peer-avatars">
      {visible.map((peer) => {
        const following = followingId === peer.memberId
        return (
          <Button
            key={peer.memberId}
            variant="ghost"
            size="xs"
            shape="flush"
            iconOnly
            pressed={following}
            className={cn(styles.avatar, following && styles.following)}
            style={{ '--peer-color': liveColorVar(peer.colorIndex) } as CSSProperties}
            aria-label={following ? `Stop following ${peer.name}` : `Follow ${peer.name}`}
            tooltip={following ? `Following ${peer.name}. Click to stop.` : `${peer.name} - click to follow their view`}
            data-testid="peer-avatar"
            data-member-id={peer.memberId}
            onClick={() => toggleFollow(peer.memberId)}
          >
            <UserAvatar
              user={{ avatarUrl: peer.avatarUrl, gravatarHash: '', displayName: peer.name, email: '' }}
              size={22}
              alt={null}
            />
          </Button>
        )
      })}
      {hidden > 0 ? <span className={styles.overflow}>+{hidden}</span> : null}
    </div>
  )
}
