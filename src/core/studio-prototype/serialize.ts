/**
 * serialize — the read/write boundary for `.studio/prototype.json`.
 *
 * Tolerant on read, strict on write, mirroring `@core/studio-board`'s and
 * `@core/studio-comments`' serializers: a malformed link is DROPPED or
 * REPAIRED, never thrown. This file is hand-editable, lives in a git repo and
 * gets merged by humans — one bad entry from a botched conflict resolution must
 * not take the whole flow with it, and must certainly not crash the editor on
 * load.
 *
 * The line between repair and drop:
 *
 *   - REPAIR anything cosmetic or derivable. An unknown transition, or one that
 *     is illegal for its action, becomes that action's default. An unreadable
 *     trigger — including the bare `"click"` string Phase 1 wrote — becomes a
 *     plain click. A `back` link carrying a leftover target loses the target.
 *   - DROP anything where guessing would invent a flow the user never drew: no
 *     source page, no source node, or a `navigate`/`overlay` with no target.
 */
import type { NodeHint } from '@core/studio-anchor'
import {
  ACTION_TRANSITIONS,
  CLICK_TRIGGER,
  DEFAULT_TRIGGER_DELAY_MS,
  MAX_TRIGGER_DELAY_MS,
  actionTakesTarget,
  createPrototypeFile,
  type PrototypeAction,
  type PrototypeFile,
  type PrototypeLink,
  type PrototypeSource,
  type PrototypeTransition,
  type PrototypeTrigger,
} from './types'

export function serializePrototypeFile(file: PrototypeFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function coerceAction(raw: unknown): PrototypeAction | undefined {
  return raw === 'navigate' || raw === 'overlay' || raw === 'back' || raw === 'close' ? raw : undefined
}

/**
 * The transition to use for `action`, given whatever the file claimed.
 *
 * `undefined` for `back`/`close` — they have no transition of their own, they
 * reverse the one that brought you here. For the other two, an unknown or
 * illegal value falls back to the action's first legal transition rather than
 * dropping the link: the destination is the part the user drew, the animation
 * is the part they can re-pick in one click.
 */
function coerceTransition(action: PrototypeAction, raw: unknown): PrototypeTransition | undefined {
  const legal = ACTION_TRANSITIONS[action]
  if (legal.length === 0) return undefined
  const found = legal.find((t) => t === raw)
  return found ?? legal[0]
}

/**
 * The trigger to use, given whatever the file claimed.
 *
 * ONE REPAIR RULE, AND IT NEVER DROPS THE LINK. Anything this reader cannot
 * make sense of — a bare `"click"` string from a Phase-1 file, a kind from a
 * newer build, a `key` trigger naming no key — becomes a plain click. The
 * destination is what the user drew; what makes it fire is one pick in the
 * inspector, and a link that silently disappeared because its trigger was
 * unreadable is strictly worse than one that fires on the obvious gesture.
 *
 * A `key` with an empty key is repaired rather than kept because it could never
 * fire: there is no keystroke it matches, so storing it would be storing a link
 * the player is guaranteed to ignore.
 */
function coerceTrigger(raw: unknown): PrototypeTrigger {
  if (!isPlainObject(raw)) return CLICK_TRIGGER
  switch (raw.kind) {
    case 'hover':
      return { kind: 'hover' }
    case 'press':
      // Absent means "yes": Figma's press trigger is "while pressing", and a
      // press that does not come back is the deliberate choice of the two.
      return { kind: 'press', reverseOnRelease: raw.reverseOnRelease !== false }
    case 'after-delay': {
      const ms = typeof raw.ms === 'number' && Number.isFinite(raw.ms) ? raw.ms : DEFAULT_TRIGGER_DELAY_MS
      return { kind: 'after-delay', ms: Math.min(Math.max(Math.round(ms), 0), MAX_TRIGGER_DELAY_MS) }
    }
    case 'key': {
      const key = str(raw.key)
      return key.length > 0 ? { kind: 'key', key } : CLICK_TRIGGER
    }
    default:
      return CLICK_TRIGGER
  }
}

function coerceNodeHint(raw: unknown): NodeHint | undefined {
  if (!isPlainObject(raw)) return undefined
  const nodeId = str(raw.nodeId)
  // A link with no source element is not a link. Unlike a comment pin, there is
  // no coordinate fallback that would still mean something.
  if (nodeId.length === 0) return undefined
  const indexPath = Array.isArray(raw.indexPath)
    ? raw.indexPath.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    : []
  return {
    nodeId,
    indexPath,
    moduleId: str(raw.moduleId),
    textSnippet: str(raw.textSnippet),
  }
}

function coerceSource(raw: unknown): PrototypeSource | undefined {
  if (!isPlainObject(raw)) return undefined
  const pageId = str(raw.pageId)
  if (pageId.length === 0) return undefined
  const node = coerceNodeHint(raw.node)
  if (!node) return undefined
  return { pageId, node }
}

function coerceLink(raw: unknown): PrototypeLink | undefined {
  if (!isPlainObject(raw)) return undefined

  const id = str(raw.id)
  if (id.length === 0) return undefined

  const action = coerceAction(raw.action)
  if (!action) return undefined

  const source = coerceSource(raw.source)
  if (!source) return undefined

  // `back`/`close` never carry a target; `navigate`/`overlay` are meaningless
  // without one, so a missing target drops the link rather than inventing a
  // destination.
  const rawTarget = str(raw.targetPageId)
  const targetPageId = actionTakesTarget(action) ? rawTarget : ''
  if (actionTakesTarget(action) && targetPageId.length === 0) return undefined

  const transition = coerceTransition(action, raw.transition)

  return {
    id,
    source,
    trigger: coerceTrigger(raw.trigger),
    action,
    targetPageId: targetPageId.length > 0 ? targetPageId : null,
    ...(transition ? { transition } : {}),
  }
}

export function parsePrototypeFile(raw: unknown): PrototypeFile {
  let value: unknown = raw

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return createPrototypeFile()
    }
  }

  if (!isPlainObject(value)) return createPrototypeFile()
  if (!Array.isArray(value.links)) return createPrototypeFile()

  return {
    version: 1,
    links: value.links.map(coerceLink).filter((l): l is PrototypeLink => l !== undefined),
  }
}
