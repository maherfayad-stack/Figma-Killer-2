/**
 * The room registry: one {@link ProjectRoom} per real project path, created on
 * the first member and dropped with the last (its timer with it).
 *
 * Single process by design — rooms, like the write lock they share a key with,
 * live in this process's memory (provisional, owner to confirm: OD-MP-10).
 */
import { LIVE_COALESCE_MS } from '@core/studio-live'
import { onProjectWriteSessionEnd } from '../projectWriteLock'
import { ProjectRoom } from './room'

interface RoomEntry {
  room: ProjectRoom
  timer: ReturnType<typeof setInterval>
}

const rooms = new Map<string, RoomEntry>()
let unsubscribeWrites: (() => void) | null = null

/** The room for `key`, if anyone is in it. */
export function existingRoom(key: string): ProjectRoom | undefined {
  return rooms.get(key)?.room
}

/** The room for `key`, created (and its clock started) when absent. */
export function roomFor(key: string): ProjectRoom {
  const found = rooms.get(key)
  if (found) return found.room
  const room = new ProjectRoom()
  // Deliberately not `unref`ed: under Bun an unreferenced timer is not
  // guaranteed to fire. It is cleared as soon as the room empties.
  const timer = setInterval(() => room.tick(Date.now()), LIVE_COALESCE_MS)
  rooms.set(key, { room, timer })
  if (!unsubscribeWrites) {
    // Revision order == lock order: bumped as each write session ends.
    unsubscribeWrites = onProjectWriteSessionEnd((realRoot) => {
      rooms.get(realRoot)?.room.bumpRev()
    })
  }
  return room
}

/** Drops the room when its last member has left. Safe to call on any leave. */
export function releaseRoomIfEmpty(key: string): void {
  const entry = rooms.get(key)
  if (!entry || entry.room.size > 0) return
  clearInterval(entry.timer)
  rooms.delete(key)
  if (rooms.size === 0 && unsubscribeWrites) {
    unsubscribeWrites()
    unsubscribeWrites = null
  }
}
