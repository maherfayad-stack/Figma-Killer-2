/**
 * The numbers the live channel is built on. One module so the server's TTL
 * sweep, the client's heartbeat and the tests cannot disagree about them.
 */

/** Client -> server keep-alive cadence while the tab is otherwise silent. */
export const LIVE_HEARTBEAT_MS = 2_000
/** A member that has sent nothing for this long is gone (2.5 missed heartbeats). */
export const LIVE_TTL_MS = 5_000
/** The server forwards at most one presence frame per member per tick (~30 Hz). */
export const LIVE_COALESCE_MS = 33
/** Clients throttle their own cursor sends to the same rate the server forwards. */
export const LIVE_CURSOR_SEND_MS = 33
/** A followed member's viewport is sent at 10 Hz, and only while somebody follows. */
export const LIVE_VIEWPORT_SEND_MS = 100
/** Most members one project room admits (provisional, owner to confirm: OD-MP-9). */
export const LIVE_ROOM_CAP = 12
/** Hard cap on one inbound frame; larger frames are refused by the socket itself. */
export const LIVE_MAX_FRAME_BYTES = 4_096
/** Presence frames per second a socket may send before it is closed (1008). */
export const LIVE_PRESENCE_RATE_PER_S = 40
/** Every other frame type (hello, follow, ping) per second. */
export const LIVE_CONTROL_RATE_PER_S = 5
/** Number of identity colours; `colorIndex` 1..N maps to `--accent-N`. */
export const LIVE_COLOR_COUNT = 10
/** Selected node ids carried per presence frame. */
export const LIVE_MAX_SELECTION_IDS = 64
