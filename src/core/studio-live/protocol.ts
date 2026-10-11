/**
 * Studio live channel — the wire protocol of `GET /admin/api/studio/live`.
 *
 * Schema-first, shared by the server room and the client store. The socket is a
 * presence + notification bus ONLY: no edit ever travels over it, so there is
 * no second write policy (every write still goes through the HTTP routes, the
 * route gate and the project write lock).
 *
 * Coordinates are BOARD space — the same space frames, notes and comment pins
 * live in — so each peer draws them through its own pan/zoom.
 */
import { Type, type Static } from '@sinclair/typebox'
import { LIVE_COLOR_COUNT, LIVE_MAX_SELECTION_IDS } from './constants'

const BoardCoord = Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })
const NodeIdString = Type.String({ minLength: 1, maxLength: 200 })
const MemberIdString = Type.String({ minLength: 1, maxLength: 64 })

export const LiveCursorSchema = Type.Object({ x: BoardCoord, y: BoardCoord }, { additionalProperties: false })
export type LiveCursor = Static<typeof LiveCursorSchema>

export const LiveSelectionSchema = Type.Object(
  {
    ids: Type.Array(NodeIdString, { maxItems: LIVE_MAX_SELECTION_IDS }),
    /** The page the node ids belong to; ids are only meaningful within one page. */
    pageId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    /** The sender's project revision when it made this selection. */
    rev: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type LiveSelection = Static<typeof LiveSelectionSchema>

/** The board-space rectangle a member currently sees, plus its zoom. */
export const LiveViewportSchema = Type.Object(
  {
    x: BoardCoord,
    y: BoardCoord,
    w: Type.Number({ exclusiveMinimum: 0, maximum: 4_000_000 }),
    h: Type.Number({ exclusiveMinimum: 0, maximum: 4_000_000 }),
    zoom: Type.Number({ exclusiveMinimum: 0, maximum: 1_000 }),
  },
  { additionalProperties: false },
)
export type LiveViewport = Static<typeof LiveViewportSchema>

/**
 * The presence fields: every one optional, `null` clears it. A field that is
 * absent means "unchanged".
 */
const presenceFields = {
  cursor: Type.Optional(Type.Union([LiveCursorSchema, Type.Null()])),
  selection: Type.Optional(Type.Union([LiveSelectionSchema, Type.Null()])),
  viewport: Type.Optional(Type.Union([LiveViewportSchema, Type.Null()])),
}

export const LivePresenceFieldsSchema = Type.Object(presenceFields, { additionalProperties: false })
export type LivePresenceFields = Static<typeof LivePresenceFieldsSchema>

export const LiveMemberSchema = Type.Object(
  {
    memberId: MemberIdString,
    userId: Type.String({ minLength: 1, maxLength: 200 }),
    name: Type.String({ maxLength: 200 }),
    avatarUrl: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()]),
    /** 1..10 -> `--accent-N`. Stable per user per room. */
    colorIndex: Type.Integer({ minimum: 1, maximum: LIVE_COLOR_COUNT }),
    kind: Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('guest')]),
    joinedAt: Type.Number(),
  },
  { additionalProperties: false },
)
export type LiveMember = Static<typeof LiveMemberSchema>

// --- client -> server --------------------------------------------------------

export const LiveClientMessageSchema = Type.Union([
  Type.Object({ t: Type.Literal('hello') }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal('presence'), ...presenceFields }, { additionalProperties: false }),
  Type.Object(
    {
      t: Type.Literal('follow'),
      /** The member to follow, or `null` to stop. */
      memberId: Type.Union([MemberIdString, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ t: Type.Literal('ping') }, { additionalProperties: false }),
])
export type LiveClientMessage = Static<typeof LiveClientMessageSchema>

// --- server -> client --------------------------------------------------------

/** One member's presence, as carried in `welcome` and in batches. */
export const LivePresenceFrameSchema = Type.Object({ m: MemberIdString, ...presenceFields }, { additionalProperties: false })
export type LivePresenceFrame = Static<typeof LivePresenceFrameSchema>

export const LiveServerMessageSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal('welcome'),
      /** Random per server start; a changed epoch means the client must resync. */
      epoch: Type.String(),
      rev: Type.Integer({ minimum: 0 }),
      you: Type.String(),
      members: Type.Array(LiveMemberSchema),
      presence: Type.Array(LivePresenceFrameSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object({ t: Type.Literal('member-joined'), member: LiveMemberSchema }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal('member-left'), memberId: Type.String() }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal('presence-batch'), frames: Type.Array(LivePresenceFrameSchema) }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal('followed-by'), count: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal('rev'), rev: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ t: Type.Literal('error'), code: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
])
export type LiveServerMessage = Static<typeof LiveServerMessageSchema>

/** The one route the socket upgrades on. Declared in `routeCapabilities.ts`. */
export const LIVE_ROUTE_PATH = '/admin/api/studio/live'
