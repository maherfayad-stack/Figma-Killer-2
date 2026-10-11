/**
 * PresenceCoalescer — latest-wins merging of presence updates between ticks.
 *
 * A client may send a cursor frame every few milliseconds; the room forwards at
 * most one frame per member per tick (~30 Hz, `LIVE_COALESCE_MS`). Anything
 * newer replaces anything older field by field, so a stale cursor position is
 * dropped rather than queued: the memory is bounded by the member count, never
 * by the send rate. A `selection` pushed between two cursor frames is not lost
 * to the later cursor-only frame, because fields merge independently.
 */
import type { LivePresenceFields, LivePresenceFrame } from '@core/studio-live'

export class PresenceCoalescer {
  private pending = new Map<string, LivePresenceFields>()

  /** Merges `fields` over whatever is already waiting for `memberId`. */
  push(memberId: string, fields: LivePresenceFields): void {
    const current = this.pending.get(memberId) ?? {}
    if (fields.cursor !== undefined) current.cursor = fields.cursor
    if (fields.selection !== undefined) current.selection = fields.selection
    if (fields.viewport !== undefined) current.viewport = fields.viewport
    this.pending.set(memberId, current)
  }

  /** Forgets a member's waiting update (it left). */
  drop(memberId: string): void {
    this.pending.delete(memberId)
  }

  /** The merged frames since the last drain, emptying the buffer. */
  drain(): LivePresenceFrame[] {
    if (this.pending.size === 0) return []
    const frames: LivePresenceFrame[] = []
    for (const [m, fields] of this.pending) frames.push({ m, ...fields })
    this.pending.clear()
    return frames
  }
}
