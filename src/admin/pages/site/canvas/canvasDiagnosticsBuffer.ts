/**
 * Per-frame runtime-diagnostics buffer — the storage half of
 * `CanvasDiagnosticsInjector`, read back by the browser leg of
 * `studio_page_diagnostics`.
 *
 * ## Why a buffer at all
 *
 * A canvas frame whose component throws renders as a blank rectangle. To an
 * agent holding only a PNG that is indistinguishable from a screen that
 * genuinely has nothing on it, from one whose CSS collapsed it to zero height,
 * and from a capture taken a beat too early — so the answer it reaches for is
 * another screenshot, then a stylesheet edit, against a page that never
 * executed. The error text exists, in the frame's own console, for a fraction
 * of a second, and nothing was keeping it.
 *
 * ## Where it lives, and why not a global registry
 *
 * Keyed by the iframe's own `Window` in a `WeakMap`, NOT by page id in a
 * module-level `Map`. Two reasons, both structural:
 *
 *   - The injector mounts inside `IframeFrameSurface`, which knows its
 *     breakpoint id and nothing about pages. A page-keyed registry would need
 *     an id threaded down through a component that has no other use for one.
 *   - A frame's diagnostics are only meaningful for the document that produced
 *     them. Keying on the window means a re-mount, a `srcDoc` swap, or a closed
 *     board drops its buffer automatically — there is no key to leak under and
 *     no eviction pass to get wrong. A stale buffer surviving a reload would be
 *     worse than no buffer: it would report a fixed error as still live.
 *
 * ## Aggregation, not a log tail
 *
 * A React render loop emits the SAME error hundreds of times per second. A ring
 * buffer of the last N lines fills entirely with one repeated message and
 * evicts the first error — which is usually the cause. So entries are
 * aggregated by `(kind, code, message, url)`: the first occurrence is kept
 * verbatim, later identical ones only bump `count`/`lastAt`. The result is a
 * count, not a vibe ("this threw 412 times since load"), and the cap applies to
 * DISTINCT problems, which is the number that is actually bounded in practice.
 *
 * ## The scope key, and why the `Window` key could not do this job alone (Z5/P8)
 *
 * The `WeakMap<Window, …>` above is the right key for the AGENT's read
 * (`studio_page_diagnostics` finds a page's frame in the DOM and reads its
 * `contentWindow`). It is the wrong key for a UI that has to RE-RENDER when a
 * finding lands: a React component cannot subscribe to a `Window` it can only
 * obtain by reaching through a ref during render, and a cross-origin bridge
 * frame's `Window` is a `WindowProxy` its own parent component never holds.
 *
 * So a frame optionally registers a **scope key** — a plain string, supplied by
 * whichever component mounted the frame (`BoardFrameView` passes the board
 * frame id; the Play surface passes `live:<pageId>`) through
 * `CanvasDiagnosticsScopeContext`. Every record also publishes that frame's
 * current entries under its scope key, and {@link subscribeScopeDiagnostics}
 * is what the per-frame badge and the Play surface's crash card subscribe to.
 * One writer, one place: there is no second collection path to drift, and a
 * frame with no scope key (a capture frame, an agent snapshot) simply collects
 * for the agent and notifies nobody.
 *
 * The published array is cached and only replaced when a record actually lands,
 * so it is a safe `useSyncExternalStore` snapshot — returning a fresh array on
 * every read would loop React forever.
 */

import type { PageDiagnosticCode } from '@core/ai'

/** What produced a diagnostic. Narrower than the reported `code` — a resource failure maps to two different codes. */
export type CanvasDiagnosticKind =
  | 'uncaughtError'
  | 'unhandledRejection'
  | 'consoleError'
  | 'resource'
  | 'network'

/** One distinct problem, with how many times it happened. */
export interface CanvasDiagnosticEntry {
  kind: CanvasDiagnosticKind
  /** The stable, documented finding code — one vocabulary, defined in `@core/ai`'s `pageDiagnostics.ts`. */
  code: PageDiagnosticCode
  /** Human-readable text, already truncated to {@link MAX_MESSAGE_LENGTH}. */
  message: string
  /** Where the failure came from: a script URL for an exception, the requested URL for a resource/network failure. */
  url?: string
  /** 1-based line/column inside `url`, when the browser reported them. */
  line?: number
  column?: number
  /** HTTP status for a `network-request-failed` that got a response at all. */
  status?: number
  /** Lowercased tag name for an `asset-load-failed` (`img`, `script`, `link`, …). */
  tagName?: string
  /**
   * The nearest enclosing `data-node-id` for a failure that happened ON an
   * element. A Studio node id IS a source location (`relFile:line:col`), so
   * this is what lets the tool answer a runtime failure with a `file:line`
   * instead of a symptom — see the server tool's `decodeSourceNodeId` call.
   */
  nodeId?: string
  /** First few stack frames, when one was available. Bounded — see {@link MAX_STACK_LENGTH}. */
  stack?: string
  /** Occurrences of this exact problem since the frame loaded. */
  count: number
  firstAt: number
  lastAt: number
}

export interface CanvasDiagnosticsSnapshot {
  /** When the collector was installed into this frame's document — the "since" in "since load". */
  installedAt: number
  entries: CanvasDiagnosticEntry[]
  /** Distinct problems dropped because {@link MAX_DISTINCT_ENTRIES} was already full. */
  droppedDistinct: number
}

/**
 * Cap on DISTINCT problems per frame. A screen with more than this many
 * genuinely different failures is broken in a way the first 100 already
 * describe; the overflow count keeps the report honest rather than silently
 * truncating.
 */
const MAX_DISTINCT_ENTRIES = 100
const MAX_MESSAGE_LENGTH = 400
const MAX_STACK_LENGTH = 600

interface FrameBuffer {
  installedAt: number
  /** Insertion-ordered — a `Map` preserves the order problems first appeared, which is the order worth reading. */
  byKey: Map<string, CanvasDiagnosticEntry>
  droppedDistinct: number
  /** The UI-facing subscription key for this frame, when its mounting component supplied one — see "The scope key" in the module doc. */
  scopeKey: string | null
}

const buffers = new WeakMap<Window, FrameBuffer>()

// ---------------------------------------------------------------------------
// Scope-keyed publication — the UI half. See the module doc.
// ---------------------------------------------------------------------------

const EMPTY_ENTRIES: readonly CanvasDiagnosticEntry[] = []

const publishedByScope = new Map<string, readonly CanvasDiagnosticEntry[]>()
const scopeListeners = new Map<string, Set<() => void>>()

function publishScope(scopeKey: string, entries: readonly CanvasDiagnosticEntry[]): void {
  publishedByScope.set(scopeKey, entries)
  for (const listener of scopeListeners.get(scopeKey) ?? []) listener()
}

/**
 * This frame's findings, newest problem first, as a STABLE array reference that
 * only changes when a finding actually lands — safe as a `useSyncExternalStore`
 * snapshot. An unknown scope key answers the shared empty array, not a fresh
 * one, for the same reason.
 */
export function getScopeDiagnostics(scopeKey: string): readonly CanvasDiagnosticEntry[] {
  return publishedByScope.get(scopeKey) ?? EMPTY_ENTRIES
}

export function subscribeScopeDiagnostics(scopeKey: string, listener: () => void): () => void {
  let set = scopeListeners.get(scopeKey)
  if (!set) {
    set = new Set()
    scopeListeners.set(scopeKey, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) scopeListeners.delete(scopeKey)
  }
}

/**
 * The codes that mean "this screen did not render", as opposed to "this screen
 * rendered and something on it complained". The Play surface's crash card and
 * the board badge's tone both key on this: a missing image or a 404 from a
 * backend that is not running is worth a quiet dot, never a card claiming the
 * screen crashed.
 */
const CRASH_CODES: ReadonlySet<PageDiagnosticCode> = new Set<PageDiagnosticCode>([
  'runtime-uncaught-error',
  'runtime-unhandled-rejection',
  'module-resolution-failed',
])

export function isCrashDiagnostic(entry: CanvasDiagnosticEntry): boolean {
  return CRASH_CODES.has(entry.code)
}

/** Truncate loudly — a silently cut message reads as a different error than the one that happened. */
function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Install (or reuse) this frame's buffer. Idempotent: a re-mount against the
 * same window keeps what it already collected.
 *
 * `scopeKey` is the optional UI subscription key (see the module doc). A
 * re-mount that supplies one where the existing buffer had none adopts it — a
 * frame that started collecting before its scope was known must not be left
 * publishing to nobody forever.
 */
export function ensureFrameDiagnostics(view: Window, scopeKey?: string): void {
  const existing = buffers.get(view)
  if (existing) {
    if (scopeKey && existing.scopeKey !== scopeKey) {
      existing.scopeKey = scopeKey
      publishScope(scopeKey, orderedEntries(existing))
    }
    return
  }
  buffers.set(view, {
    installedAt: Date.now(),
    byKey: new Map(),
    droppedDistinct: 0,
    scopeKey: scopeKey ?? null,
  })
  // Publish immediately so a scope that had findings from a PREVIOUS document
  // (a reloaded frame, a bridge iframe that re-booted) is cleared rather than
  // showing a badge for errors that are no longer true.
  if (scopeKey) publishScope(scopeKey, EMPTY_ENTRIES)
}

/** Drop this frame's buffer entirely — used when the collector uninstalls. */
export function disposeFrameDiagnostics(view: Window): void {
  const buffer = buffers.get(view)
  if (buffer?.scopeKey) {
    publishedByScope.delete(buffer.scopeKey)
    for (const listener of scopeListeners.get(buffer.scopeKey) ?? []) listener()
  }
  buffers.delete(view)
}

export type CanvasDiagnosticInput = Omit<CanvasDiagnosticEntry, 'count' | 'firstAt' | 'lastAt'>

/**
 * Record one occurrence. Identical problems collapse onto one entry — see the
 * module doc's "Aggregation, not a log tail".
 */
export function recordFrameDiagnostic(view: Window, input: CanvasDiagnosticInput): void {
  const buffer = buffers.get(view)
  if (!buffer) return
  const entry: CanvasDiagnosticInput = {
    ...input,
    message: bound(input.message, MAX_MESSAGE_LENGTH),
    ...(input.stack === undefined ? {} : { stack: bound(input.stack, MAX_STACK_LENGTH) }),
  }
  // `nodeId` is part of the identity: the same broken URL referenced from two
  // different elements is two different source lines to fix, and collapsing
  // them would hide one of them.
  const key = [entry.kind, entry.code, entry.message, entry.url ?? '', entry.nodeId ?? ''].join(' | ')
  const existing = buffer.byKey.get(key)
  const now = Date.now()
  if (existing) {
    existing.count += 1
    existing.lastAt = now
  } else if (buffer.byKey.size >= MAX_DISTINCT_ENTRIES) {
    buffer.droppedDistinct += 1
    return
  } else {
    buffer.byKey.set(key, { ...entry, count: 1, firstAt: now, lastAt: now })
  }
  // A repeat re-publishes too: the badge shows counts, and a problem that just
  // went from 1 to 400 occurrences is a different thing on screen. Cheap — the
  // whole map is bounded at `MAX_DISTINCT_ENTRIES`, and both collectors
  // rate-limit well below one record per frame.
  if (buffer.scopeKey) publishScope(buffer.scopeKey, orderedEntries(buffer))
}

/**
 * Newest problem first — what a badge popover showing "the last 5" should show.
 * Copies, so a published snapshot can never be mutated by a later record.
 *
 * `.reverse()` before a STABLE sort, deliberately: `Date.now()` has
 * millisecond resolution and a broken screen produces several distinct
 * failures inside one millisecond, so `lastAt` ties constantly. Reversed
 * insertion order is the correct tiebreak for "newest", and `Array.sort` is
 * specified stable, so it survives the sort intact. Comparing only timestamps
 * would leave the order of a tie up to insertion order — i.e. oldest first,
 * exactly backwards.
 */
function orderedEntries(buffer: FrameBuffer): readonly CanvasDiagnosticEntry[] {
  return [...buffer.byKey.values()]
    .map((entry) => ({ ...entry }))
    .reverse()
    .sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * Everything this frame has collected since the collector was installed, or
 * `null` when no collector is installed in that window at all — a genuinely
 * different answer from "installed and clean", and the tool reports it as such
 * rather than claiming a broken page is healthy.
 */
export function readFrameDiagnostics(view: Window): CanvasDiagnosticsSnapshot | null {
  const buffer = buffers.get(view)
  if (!buffer) return null
  return {
    installedAt: buffer.installedAt,
    entries: [...buffer.byKey.values()].map((entry) => ({ ...entry })),
    droppedDistinct: buffer.droppedDistinct,
  }
}
