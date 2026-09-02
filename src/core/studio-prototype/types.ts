/**
 * Studio prototype links — the persisted shape of
 * `<workspace>/.studio/prototype.json`.
 *
 * A prototype link says "clicking THIS element goes to THAT screen, like this".
 * It is a design layer: it is never written into the user's `.tsx` files, and
 * the publisher never sees it. See `STUDIO-PROTOTYPE-PLAN.md` §1 for why
 * writing real `onClick` handlers instead was rejected — "make a sheet slide up
 * from here" has no single honest target in arbitrary React, and Studio refuses
 * writes without exactly one honest target.
 *
 * WHY A SEPARATE FILE FROM `boards.json`
 * ──────────────────────────────────────
 * Same three reasons `@core/studio-comments` gives for its own file:
 *
 *   - `boards.json` rides an 800 ms dirty-flag autosave
 *     (`useStudioBoardsPersistence`). Link authoring has no business there.
 *   - A flow is worth reading as a git diff on its own.
 *   - **A link outlives the board it was drawn on.** It is about a page and an
 *     element, not about board furniture. Removing a frame from a board must
 *     not destroy the flow through that screen — which is exactly why `source`
 *     names a `pageId` and never a `frameId`.
 *
 * WHY `source` IS A HINT AND NOT AN ID
 * ────────────────────────────────────
 * Studio node ids are `relFile:line:col`, so they rot on nearly every edit. A
 * link stored as a bare `nodeId` would break silently and constantly. `source.node`
 * is a `NodeHint` (`@core/studio-anchor`), re-resolved against the live tree on
 * every load. A link whose source resolves `detached` is drawn as a visibly
 * broken connector rather than quietly disappearing.
 */
import { Type, type Static, withFallback } from '@core/utils/typeboxHelpers'
import { NodeHintSchema } from '@core/studio-anchor'

/** What a click does. Phase 1 has exactly one trigger; `hover`/`drag` can follow. */
export const PrototypeTriggerSchema = Type.Union([Type.Literal('click')])
export type PrototypeTrigger = Static<typeof PrototypeTriggerSchema>

/**
 * The four things a link can do.
 *
 *   - `navigate` — replace the screen. Pushes onto the history stack.
 *   - `overlay`  — present on top; the base screen stays mounted underneath.
 *   - `back`     — pop the history stack, reversing whatever brought you here.
 *   - `close`    — dismiss the top overlay, reversing its presentation.
 *
 * `back` and `close` are the two that take no target and no transition: both
 * are defined entirely by what is already on the stack.
 */
export const PrototypeActionSchema = Type.Union([
  Type.Literal('navigate'),
  Type.Literal('overlay'),
  Type.Literal('back'),
  Type.Literal('close'),
])
export type PrototypeAction = Static<typeof PrototypeActionSchema>

export const PrototypeTransitionSchema = Type.Union([
  Type.Literal('instant'),
  Type.Literal('dissolve'),
  Type.Literal('slide-left'),
  Type.Literal('slide-right'),
  Type.Literal('push-left'),
  Type.Literal('push-right'),
  Type.Literal('popup'),
  Type.Literal('sheet'),
])
export type PrototypeTransition = Static<typeof PrototypeTransitionSchema>

/**
 * Which transitions each action can legally wear, and which one it falls back
 * to. A transition is not free-floating decoration: `popup` describes a centred
 * presentation over a scrim, which is meaningless for a screen replacement, and
 * `push-left` describes two screens moving together, which is meaningless for
 * something presented on top of a screen that stays put.
 *
 * `serialize.ts` repairs rather than rejects — a hand-edited file that pairs
 * `navigate` with `sheet` opens with `instant` instead of losing the link.
 */
export const ACTION_TRANSITIONS: Readonly<Record<PrototypeAction, readonly PrototypeTransition[]>> = {
  navigate: ['instant', 'dissolve', 'slide-left', 'slide-right', 'push-left', 'push-right'],
  overlay: ['popup', 'sheet'],
  back: [],
  close: [],
}

/** Whether this action names a target screen at all. */
export function actionTakesTarget(action: PrototypeAction): boolean {
  return action === 'navigate' || action === 'overlay'
}

export const PrototypeSourceSchema = Type.Object({
  /**
   * The page the clickable element lives on. NOT a `frameId` — two variant
   * frames of one page share every node id by design, so a link authored on
   * either is the same link, and removing a frame must not orphan it.
   */
  pageId: Type.String(),
  /** The element, as it looked when the link was drawn. Expect it to go stale. */
  node: NodeHintSchema,
})
export type PrototypeSource = Static<typeof PrototypeSourceSchema>

export const PrototypeLinkSchema = Type.Object({
  id: Type.String(),
  /**
   * `design` — the user drew it. `code` — Studio read it out of a real `onClick`
   * in their source (Phase 6) and it is READ-ONLY on the board.
   *
   * Present from Phase 1 precisely so Phase 6 needs no migration: the board's
   * whole differentiator is showing flows that are already true in the code
   * beside the ones the designer invented, drawn differently.
   */
  origin: Type.Union([Type.Literal('design'), Type.Literal('code')]),
  source: PrototypeSourceSchema,
  trigger: PrototypeTriggerSchema,
  action: PrototypeActionSchema,
  /** The destination page. Always `null` for `back`/`close`. */
  targetPageId: Type.Union([Type.String(), Type.Null()]),
  /** Absent for `back`/`close`, which reverse whatever brought them here. */
  transition: Type.Optional(PrototypeTransitionSchema),
})
export type PrototypeLink = Static<typeof PrototypeLinkSchema>

export const PrototypeFileSchema = Type.Object({
  version: Type.Literal(1),
  links: withFallback(Type.Array(PrototypeLinkSchema), []),
})
export type PrototypeFile = Static<typeof PrototypeFileSchema>

export function createPrototypeFile(): PrototypeFile {
  return { version: 1, links: [] }
}
