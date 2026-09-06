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
}

const buffers = new WeakMap<Window, FrameBuffer>()

/** Truncate loudly — a silently cut message reads as a different error than the one that happened. */
function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Install (or reuse) this frame's buffer. Idempotent: a re-mount against the same window keeps what it already collected. */
export function ensureFrameDiagnostics(view: Window): void {
  if (buffers.has(view)) return
  buffers.set(view, { installedAt: Date.now(), byKey: new Map(), droppedDistinct: 0 })
}

/** Drop this frame's buffer entirely — used when the collector uninstalls. */
export function disposeFrameDiagnostics(view: Window): void {
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
    return
  }
  if (buffer.byKey.size >= MAX_DISTINCT_ENTRIES) {
    buffer.droppedDistinct += 1
    return
  }
  buffer.byKey.set(key, { ...entry, count: 1, firstAt: now, lastAt: now })
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
