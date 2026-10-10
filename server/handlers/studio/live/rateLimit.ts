/**
 * Per-socket frame budget. A socket that exceeds it is closed (1008), not
 * throttled: a client built to spec (30 Hz cursor, 2 s heartbeat) never gets
 * near the limits, so exceeding them means a script, not a person.
 */
import { LIVE_CONTROL_RATE_PER_S, LIVE_PRESENCE_RATE_PER_S } from '@core/studio-live'

export type LiveFrameClass = 'presence' | 'control'

export class FrameRateLimiter {
  private windowStart = 0
  private presence = 0
  private control = 0

  /** `false` when this frame is over the per-second budget for its class. */
  allow(frameClass: LiveFrameClass, nowMs: number): boolean {
    if (nowMs - this.windowStart >= 1_000) {
      this.windowStart = nowMs
      this.presence = 0
      this.control = 0
    }
    if (frameClass === 'presence') return ++this.presence <= LIVE_PRESENCE_RATE_PER_S
    return ++this.control <= LIVE_CONTROL_RATE_PER_S
  }
}
