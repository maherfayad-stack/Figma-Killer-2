import { describe, expect, it } from 'bun:test'
import { encodeLiveMessage, type LiveClientMessage, type LiveServerMessage } from '@core/studio-live'
import { LiveClient, type LiveSocketLike } from '../liveClient'
import { liveSocketUrl } from '../studioLiveConnection'
import type { LiveStatus } from '../livePresenceStore'

class FakeSocket implements LiveSocketLike {
  readyState = 0
  sent: LiveClientMessage[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(JSON.parse(data) as LiveClientMessage)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(message: LiveServerMessage): void {
    this.onmessage?.({ data: encodeLiveMessage(message) })
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const WELCOME: LiveServerMessage = { t: 'welcome', epoch: 'e', rev: 0, you: 'me', members: [], presence: [] }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function build(overrides: { sendIntervalMs?: number; heartbeatMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const statuses: LiveStatus[] = []
  const received: LiveServerMessage[] = []
  const client = new LiveClient({
    url: 'ws://x/live',
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onMessage: (m) => received.push(m),
    onStatus: (s) => statuses.push(s),
    backoffMs: [5, 10],
    sendIntervalMs: overrides.sendIntervalMs ?? 20,
    heartbeatMs: overrides.heartbeatMs ?? 15,
  })
  return { client, sockets, statuses, received }
}

describe('LiveClient', () => {
  it('says hello on open, heartbeats, and forwards validated frames only', async () => {
    const { client, sockets, received } = build()
    client.start()
    const socket = sockets[0]!
    socket.open()
    expect(socket.sent[0]).toEqual({ t: 'hello' })
    await wait(50)
    expect(socket.sent.some((m) => m.t === 'ping')).toBe(true)
    socket.onmessage?.({ data: '{"t":"nonsense"}' })
    socket.onmessage?.({ data: 'not json' })
    socket.receive(WELCOME)
    expect(received.map((m) => m.t)).toEqual(['welcome'])
    client.stop()
  })

  it('holds presence until welcomed, then sends the latest of everything', () => {
    const { client, sockets } = build()
    client.start()
    const socket = sockets[0]!
    socket.open()
    client.sendPresence({ cursor: { x: 1, y: 1 } })
    client.sendPresence({ selection: { ids: ['a'], pageId: 'p', rev: 0 } })
    expect(socket.sent.filter((m) => m.t === 'presence')).toHaveLength(0)
    socket.receive(WELCOME)
    const presence = socket.sent.filter((m) => m.t === 'presence')
    expect(presence).toHaveLength(1)
    expect(presence[0]).toMatchObject({ cursor: { x: 1, y: 1 }, selection: { ids: ['a'] } })
    client.stop()
  })

  it('throttles a burst of cursor frames to one per interval, newest last', async () => {
    const { client, sockets } = build({ sendIntervalMs: 30 })
    client.start()
    const socket = sockets[0]!
    socket.open()
    socket.receive(WELCOME)
    for (let i = 1; i <= 40; i++) client.sendPresence({ cursor: { x: i, y: i } })
    expect(socket.sent.filter((m) => m.t === 'presence')).toHaveLength(1)
    await wait(80)
    const presence = socket.sent.filter((m) => m.t === 'presence')
    expect(presence.length).toBeLessThanOrEqual(3)
    expect(presence.at(-1)).toMatchObject({ cursor: { x: 40, y: 40 } })
    client.stop()
  })

  it('reconnects with backoff, replays local state and follow after the new welcome', async () => {
    const { client, sockets, statuses } = build()
    client.start()
    sockets[0]!.open()
    sockets[0]!.receive(WELCOME)
    client.sendPresence({ cursor: { x: 7, y: 8 } })
    client.follow('ana')
    sockets[0]!.drop()
    expect(statuses.at(-1)).toBe('reconnecting')
    await wait(30)
    expect(sockets).toHaveLength(2)
    sockets[1]!.open()
    sockets[1]!.receive(WELCOME)
    expect(sockets[1]!.sent).toContainEqual({ t: 'follow', memberId: 'ana' })
    expect(sockets[1]!.sent.find((m) => m.t === 'presence')).toMatchObject({ cursor: { x: 7, y: 8 } })
    client.stop()
  })

  it('does not retry a policy close (forbidden, invalid, rate-limited) and stop() is final', async () => {
    const { client, sockets, statuses } = build()
    client.start()
    sockets[0]!.open()
    sockets[0]!.drop(1008)
    await wait(30)
    expect(sockets).toHaveLength(1)
    expect(statuses.at(-1)).toBe('off')

    const second = build()
    second.client.start()
    second.sockets[0]!.open()
    second.client.stop()
    second.sockets[0]!.drop()
    await wait(30)
    expect(second.sockets).toHaveLength(1)
  })
})

describe('liveSocketUrl', () => {
  it('uses wss on https, encodes the project dir, and omits it when unknown', () => {
    expect(liveSocketUrl('my proj', { protocol: 'https:', host: 'studio.example' })).toBe(
      'wss://studio.example/admin/api/studio/live?dir=my%20proj',
    )
    expect(liveSocketUrl(null, { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/admin/api/studio/live',
    )
  })
})
