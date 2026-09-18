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

/**
 * WHAT MAKES A LINK FIRE.
 *
 * Phase 1 had exactly one trigger, stored as the bare string `'click'`. Two of
 * the five carry data (`after-delay` needs a duration, `key` needs a key), so
 * the vocabulary is a TAGGED UNION rather than a string enum — a parallel
 * `triggerMs` / `triggerKey` pair beside a string would let a `click` link
 * carry a duration nothing reads, which is a shape that cannot be wrong on
 * purpose.
 *
 *   - `click`       — press and release on the element. The default, and what
 *                     anything unreadable repairs to (`serialize.ts`).
 *   - `hover`       — the pointer arrives. Fires once per arrival, never on
 *                     the way out.
 *   - `press`       — the pointer goes DOWN. `reverseOnRelease` makes the
 *                     release undo it, which is how "hold to peek" reads: a
 *                     `navigate` comes back, an `overlay` closes.
 *   - `after-delay` — no gesture at all: the screen arrived, and `ms` later the
 *                     link follows itself. A splash screen is this.
 *   - `key`         — a keystroke while the player is armed. Element-anchored
 *                     like every other link, because that is what a link IS —
 *                     but it fires wherever focus happens to be, so it is
 *                     scoped to the screen showing rather than to the pointer.
 *
 * Every trigger is legal for every action. There is deliberately no
 * `ACTION_TRIGGERS` table beside `ACTION_TRANSITIONS`: a transition describes
 * HOW two screens move, which an action can genuinely make meaningless, while a
 * trigger only describes what the user did — and "go back after 3 seconds" is a
 * real screen, not a contradiction.
 */
export const PrototypeTriggerSchema = Type.Union([
  Type.Object({ kind: Type.Literal('click') }),
  Type.Object({ kind: Type.Literal('hover') }),
  Type.Object({
    kind: Type.Literal('press'),
    /** Whether letting go undoes it. `true` is Figma's "while pressing". */
    reverseOnRelease: Type.Boolean(),
  }),
  Type.Object({ kind: Type.Literal('after-delay'), ms: Type.Number() }),
  Type.Object({
    kind: Type.Literal('key'),
    /** A `KeyboardEvent.key` value, matched case-insensitively. */
    key: Type.String(),
  }),
])
export type PrototypeTrigger = Static<typeof PrototypeTriggerSchema>
export type PrototypeTriggerKind = PrototypeTrigger['kind']

/**
 * The trigger every link gets unless the user picked another, and the one
 * `serialize.ts` repairs anything unreadable to.
 *
 * A shared frozen constant rather than a factory: nothing mutates a trigger in
 * place (every edit writes a whole new link), and one object means a link read
 * from disk and a link authored in the inspector compare equal.
 */
export const CLICK_TRIGGER: PrototypeTrigger = Object.freeze({ kind: 'click' })

/** How long an `after-delay` waits when the file did not say. */
export const DEFAULT_TRIGGER_DELAY_MS = 800

/**
 * The longest delay the player will schedule.
 *
 * A ceiling rather than a validation error because the file is hand-editable: a
 * botched `30000000` should cost a one-minute wait the user can see and fix,
 * not a timer nobody will sit through and no way to tell it is running.
 */
export const MAX_TRIGGER_DELAY_MS = 60_000

/** The delays the inspector offers. */
export const TRIGGER_DELAY_PRESETS_MS: readonly number[] = [200, 500, 800, 1000, 2000, 3000, 5000]

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
  /**
   * The two screens are matched element by element and the pairs that MOVED are
   * animated between their two positions; everything unmatched cross-dissolves.
   * Only a `navigate` can wear it — an overlay presents OVER a screen that stays
   * put, so there is no second layout to match against.
   */
  Type.Literal('smart-animate'),
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
  navigate: [
    'instant',
    'dissolve',
    'smart-animate',
    'slide-left',
    'slide-right',
    'push-left',
    'push-right',
  ],
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

/**
 * A link the USER drew. There is no `origin` discriminator here any more.
 *
 * Phase 1 carried `origin: 'design' | 'code'` on the guess that Phase 6's
 * code-derived flows would be the same shape with a different provenance.
 * Building Phase 6 disproved it: a derived edge is recomputed from the source
 * on every load, so it has no id to keep stable, no `NodeHint` to re-resolve,
 * and no transition anybody chose — and it needs a field this shape has no room
 * for, the snippet it was read out of. It lives next door as `CodeFlowEdge`
 * (`./codeFlow.ts`), which left `origin` with exactly one possible value.
 */
export const PrototypeLinkSchema = Type.Object({
  id: Type.String(),
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
