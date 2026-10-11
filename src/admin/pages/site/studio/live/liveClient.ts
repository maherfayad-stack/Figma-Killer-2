/**
 * LiveClient - one tab's WebSocket to a project room.
 *
 * Owns the connection life cycle (hello, 2 s heartbeat, reconnect with
 * backoff) and the outbound throttle. It knows nothing about React, the canvas
 * or the store: inbound frames go to `onMessage`, status changes to
 * `onStatus`. If the socket is down the editor simply works single-player;
 * there is no second transport.
 *
 * Outbound presence is coalesced to one frame per `sendIntervalMs` (30 Hz): the
 * first update goes out immediately, later ones within the window merge
 * field-by-field and ship when the window closes.
 */
import {
  LIVE_CURSOR_SEND_MS,
  LIVE_HEARTBEAT_MS,
  encodeLiveMessage,
  parseLiveServerMessage,
  type LiveClientMessage,
  type LivePresenceFields,
  type LiveServerMessage,
} from '@core/studio-live'
import type { LiveStatus } from './livePresenceStore'

/** The slice of `WebSocket` the client uses; tests pass a fake. */
export interface LiveSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

const SOCKET_OPEN = 1
/** Policy violation: forbidden, invalid or over budget. Retrying would repeat it. */
const CLOSE_POLICY = 1008
const DEFAULT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const

export interface LiveClientOptions {
  url: string
  onMessage: (message: LiveServerMessage) => void
  onStatus: (status: LiveStatus) => void
  createSocket: (url: string) => LiveSocketLike
  heartbeatMs?: number
  sendIntervalMs?: number
  backoffMs?: readonly number[]
}

export class LiveClient {
  private socket: LiveSocketLike | null = null
  private stopped = true
  private attempt = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private pending: LivePresenceFields | null = null
  /** The latest of every field, replayed after a reconnect. */
  private latest: LivePresenceFields = {}
  private following: string | null = null
  private welcomed = false

  private readonly options: LiveClientOptions

  constructor(options: LiveClientOptions) {
    this.options = options
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.options.onStatus('connecting')
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.close(1000)
    }
    this.pending = null
    this.welcomed = false
    this.options.onStatus('off')
  }

  /** Queues a partial presence update; absent fields are unchanged. */
  sendPresence(fields: LivePresenceFields): void {
    this.latest = { ...this.latest, ...fields }
    if (!this.welcomed) return
    this.pending = { ...(this.pending ?? {}), ...fields }
    if (this.sendTimer) return
    this.flushPresence()
  }

  follow(memberId: string | null): void {
    this.following = memberId
    if (this.welcomed) this.sendNow({ t: 'follow', memberId })
  }

  private flushPresence(): void {
    const fields = this.pending
    this.pending = null
    if (fields && Object.keys(fields).length > 0) this.sendNow({ t: 'presence', ...fields })
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      if (this.pending) this.flushPresence()
    }, this.options.sendIntervalMs ?? LIVE_CURSOR_SEND_MS)
  }

  private sendNow(message: LiveClientMessage): void {
    const socket = this.socket
    if (!socket || socket.readyState !== SOCKET_OPEN) return
    try {
      socket.send(encodeLiveMessage(message))
    } catch (err) {
      console.error('[studio-live] send failed:', err)
    }
  }

  private connect(): void {
    let socket: LiveSocketLike
    try {
      socket = this.options.createSocket(this.options.url)
    } catch (err) {
      console.error('[studio-live] could not open the live channel:', err)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      this.sendNow({ t: 'hello' })
      this.heartbeat = setInterval(() => this.sendNow({ t: 'ping' }), this.options.heartbeatMs ?? LIVE_HEARTBEAT_MS)
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const message = parseLiveServerMessage(event.data)
      if (!message) return
      if (message.t === 'welcome') {
        this.welcomed = true
        this.attempt = 0
        // Replay local state: the room forgot us when the old socket dropped.
        if (Object.keys(this.latest).length > 0) this.pending = { ...this.latest }
        if (this.following) this.sendNow({ t: 'follow', memberId: this.following })
        if (this.pending && !this.sendTimer) this.flushPresence()
      }
      this.options.onMessage(message)
    }
    socket.onclose = (event) => {
      this.socket = null
      this.welcomed = false
      this.clearTimers()
      if (this.stopped) return
      if (event.code === CLOSE_POLICY) {
        this.stopped = true
        this.options.onStatus('off')
        return
      }
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      // The close event that follows carries the outcome; nothing to do here.
    }
  }

  private scheduleReconnect(): void {
    this.options.onStatus('reconnecting')
    const ladder = this.options.backoffMs ?? DEFAULT_BACKOFF_MS
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)] ?? 8_000
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.heartbeat = null
    this.reconnectTimer = null
    this.sendTimer = null
  }
}
