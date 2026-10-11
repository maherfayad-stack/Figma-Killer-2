/**
 * The presence socket's front door: the upgrade handler's refusals (the
 * security control) and, once admitted, the socket handler's frame rules.
 *
 * No real listener: the unit-test globals replace `Response`/`Request` with
 * happy-dom's, which `Bun.serve` refuses, so the upgrade is driven with a fake
 * `upgrade()` that captures the socket data Bun would attach, and the socket
 * handler is driven with a fake socket. The wire itself is the Playwright
 * two-context spec's job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ServerWebSocket } from 'bun'
import {
  LIVE_MAX_FRAME_BYTES,
  LIVE_PRESENCE_RATE_PER_S,
  encodeLiveMessage,
  parseLiveServerMessage,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@core/studio-live'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../../src/__tests__/helpers/capabilityHarness'
import { syncSystemRoles } from '../../../../repositories/roles'
import { handleLiveUpgrade, isLiveUpgradePath, type LiveUpgrader } from '../upgrade'
import { liveWebsocketHandler, type LiveSocketData } from '../socketHandler'
import { existingRoom, releaseRoomIfEmpty } from '../registry'

let harness: CapabilityTestHarness
let root: string
let previousWorkspaceDir: string | undefined
let ownerCookie: string
let viewerCookie: string
let noAccessCookie: string

const GOOD_ORIGIN = 'http://localhost'

/** The `dir` query a client sends: the project's absolute directory, as the project list reports it. */
function alphaQuery(): string {
  return `?dir=${encodeURIComponent(path.join(root, 'alpha'))}`
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-upgrade-'))
  fs.mkdirSync(path.join(root, 'alpha', 'pages'), { recursive: true })
  previousWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
  process.env.STUDIO_WORKSPACE_DIR = root

  harness = await createCapabilityTestHarness()
  await syncSystemRoles(harness.db)
  ownerCookie = await harness.setupOwner()
  viewerCookie = (await harness.createRoleUser({ name: 'Viewer', slug: 'live-viewer', capabilities: ['site.read'] })).cookie
  noAccessCookie = (await harness.createRoleUser({ name: 'Nobody', slug: 'live-nobody', capabilities: [] })).cookie
})

afterAll(async () => {
  if (previousWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = previousWorkspaceDir
  fs.rmSync(root, { recursive: true, force: true })
  await harness.cleanup()
})

interface Attempt {
  response: Response | undefined
  data: LiveSocketData | null
}

async function handshake(options: {
  cookie?: string | null
  origin?: string | null
  query?: string
  websocket?: boolean
}): Promise<Attempt> {
  // Set after construction: the unit-test `Request` drops forbidden header
  // names (Origin) from its init, but `headers.set` keeps them (as the other
  // route tests do).
  const req = new Request(`http://localhost/admin/api/studio/live${options.query ?? alphaQuery()}`)
  if (options.cookie) req.headers.set('cookie', options.cookie)
  const origin = options.origin === undefined ? GOOD_ORIGIN : options.origin
  if (origin) req.headers.set('origin', origin)
  let data: LiveSocketData | null = null
  const upgrader: LiveUpgrader = {
    upgrade(_req, opts) {
      // Bun answers false for a request that is not a WebSocket handshake.
      if (options.websocket === false) return false
      data = opts.data
      return true
    },
  }
  const response = await handleLiveUpgrade(req, upgrader, harness.db)
  return { response, data }
}

describe('upgrade refusals', () => {
  it('refuses a handshake from another origin (cross-site WebSocket hijacking)', async () => {
    const { response, data } = await handshake({ cookie: ownerCookie, origin: 'https://evil.example' })
    expect(response?.status).toBe(403)
    expect(data).toBeNull()
  })

  it('refuses a handshake with no Origin at all', async () => {
    const { response, data } = await handshake({ cookie: ownerCookie, origin: null })
    expect(response?.status).toBe(403)
    expect(data).toBeNull()
  })

  it('refuses an anonymous caller from our own origin', async () => {
    const { response, data } = await handshake({ cookie: null })
    expect(response?.status).toBe(401)
    expect(data).toBeNull()
  })

  it('refuses a signed-in user without site.read', async () => {
    const { response, data } = await handshake({ cookie: noAccessCookie })
    expect(response?.status).toBe(403)
    expect(data).toBeNull()
  })

  it('answers 404 for a project directory outside the workspace, with no path in the body', async () => {
    for (const query of ['?dir=../outside', '?dir=%2Fetc', '?dir=C%3A%5CWindows', `?dir=${encodeURIComponent(path.join(root, 'alpha', '..', '..', 'x'))}`]) {
      const { response, data } = await handshake({ cookie: ownerCookie, query })
      expect(response?.status).toBe(404)
      expect(data).toBeNull()
      const text = await response!.text()
      expect(text).not.toContain(root)
      expect(text).not.toContain('outside')
    }
  })

  it('answers 426 to a request that is not a WebSocket handshake', async () => {
    const { response, data } = await handshake({ cookie: ownerCookie, websocket: false })
    expect(response?.status).toBe(426)
    expect(data).toBeNull()
  })

  it('never creates a room for a refused handshake', async () => {
    await handshake({ cookie: ownerCookie, origin: 'https://evil.example' })
    expect(existingRoom(fs.realpathSync(path.join(root, 'alpha')))).toBeUndefined()
  })

  it('serves exactly the declared path', () => {
    expect(isLiveUpgradePath('/admin/api/studio/live')).toBe(true)
    expect(isLiveUpgradePath('/admin/api/studio/live/')).toBe(false)
    expect(isLiveUpgradePath('/admin/api/studio/live-origin')).toBe(false)
  })
})

describe('admission', () => {
  it('admits an owner and a viewer, keyed to the project\'s real path', async () => {
    const owner = await handshake({ cookie: ownerCookie })
    const viewer = await handshake({ cookie: viewerCookie })
    expect(owner.response).toBeUndefined()
    expect(viewer.response).toBeUndefined()
    expect(owner.data?.roomKey).toBe(fs.realpathSync(path.join(root, 'alpha')))
    expect(viewer.data?.roomKey).toBe(owner.data?.roomKey)
    expect(owner.data?.identity.userId).not.toBe(viewer.data?.identity.userId)
    expect(await owner.data?.revalidate()).toBe(true)
    expect(await viewer.data?.revalidate()).toBe(true)
  })
})

class FakeWs {
  sent: LiveServerMessage[] = []
  closed: { code: number; reason?: string } | null = null
  readonly data: LiveSocketData
  constructor(data: LiveSocketData) {
    this.data = data
  }
  send(raw: string): void {
    const parsed = parseLiveServerMessage(raw)
    if (parsed) this.sent.push(parsed)
  }
  close(code: number, reason?: string): void {
    this.closed = { code, reason }
  }
  asServerSocket(): ServerWebSocket<LiveSocketData> {
    return this as unknown as ServerWebSocket<LiveSocketData>
  }
}

async function admitted(cookie: string): Promise<FakeWs> {
  const { data } = await handshake({ cookie })
  const ws = new FakeWs(data!)
  liveWebsocketHandler.open?.(ws.asServerSocket())
  return ws
}

function say(ws: FakeWs, message: LiveClientMessage | string): void {
  liveWebsocketHandler.message?.(ws.asServerSocket(), typeof message === 'string' ? message : encodeLiveMessage(message))
}

function hangUp(ws: FakeWs): void {
  liveWebsocketHandler.close?.(ws.asServerSocket(), 1000, '')
}

describe('socket handler', () => {
  it('caps a frame at the protocol limit at the socket itself', () => {
    expect(liveWebsocketHandler.maxPayloadLength).toBe(LIVE_MAX_FRAME_BYTES)
  })

  it('joins on hello, shows both people to each other, and clears the room on leave', async () => {
    const a = await admitted(ownerCookie)
    const b = await admitted(viewerCookie)
    say(a, { t: 'hello' })
    say(b, { t: 'hello' })
    const welcome = b.sent.find((m) => m.t === 'welcome')
    expect(welcome?.t === 'welcome' && welcome.members).toHaveLength(2)
    expect(a.sent.some((m) => m.t === 'member-joined')).toBe(true)

    say(a, { t: 'presence', cursor: { x: 1, y: 2 } })
    existingRoom(a.data.roomKey)?.tick(Date.now() + 1_000)
    const batch = b.sent.find((m) => m.t === 'presence-batch')
    expect(batch?.t === 'presence-batch' && batch.frames[0]?.cursor).toEqual({ x: 1, y: 2 })

    hangUp(a)
    expect(b.sent.some((m) => m.t === 'member-left')).toBe(true)
    hangUp(b)
    expect(existingRoom(a.data.roomKey)).toBeUndefined()
  })

  it('closes 1008 on an invalid frame, a binary frame, or talking before hello', async () => {
    const invalid = await admitted(ownerCookie)
    say(invalid, { t: 'hello' })
    say(invalid, JSON.stringify({ t: 'presence', cursor: { x: 'nope', y: 1 } }))
    expect(invalid.closed?.code).toBe(1008)
    hangUp(invalid)

    const binary = await admitted(ownerCookie)
    liveWebsocketHandler.message?.(binary.asServerSocket(), new Uint8Array([1, 2, 3]) as unknown as Buffer)
    expect(binary.closed?.code).toBe(1003)
    hangUp(binary)

    const early = await admitted(ownerCookie)
    say(early, { t: 'presence', cursor: { x: 1, y: 1 } })
    expect(early.closed?.code).toBe(1008)
    hangUp(early)
    releaseRoomIfEmpty(early.data.roomKey)
  })

  it('closes 1008 when a socket floods presence past the budget', async () => {
    const flood = await admitted(ownerCookie)
    say(flood, { t: 'hello' })
    for (let i = 0; i <= LIVE_PRESENCE_RATE_PER_S + 1; i++) {
      say(flood, { t: 'presence', cursor: { x: i, y: i } })
    }
    expect(flood.closed?.code).toBe(1008)
    expect(flood.closed?.reason).toBe('rate limit')
    hangUp(flood)
  })
})
