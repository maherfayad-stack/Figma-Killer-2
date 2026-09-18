/**
 * useBridgeComputedValues — the Tier 2 (`documentMode='bridge'`) half of
 * `useInspectComputedStyle.ts`'s bimodal computed-style read (P5, STATE.md
 * `panel-26`).
 *
 * Kept in its own file rather than folded into `useInspectComputedStyle.ts`
 * (already 300+ lines of dense, load-bearing doc comments) — a "one reason
 * per module" split, not a budget dodge.
 *
 * A cross-origin bridge frame has no `contentDocument`/`getComputedStyle`
 * this process can reach directly — the only way to know what actually
 * rendered is a real `postMessage` round trip
 * (`BridgeFrameAdapter.measure()`, already built and reviewed, `sec-06`).
 * That makes this hook genuinely async, unlike the portal branch's
 * same-tick DOM read.
 *
 * ## Why generation counting, not cancellation
 *
 * `BridgeFrameAdapter.measure()` already bounds every request to
 * `DEFAULT_MEASURE_TIMEOUT_MS` (2000ms) — nothing here needs an
 * `AbortController` to stop a hung request. What it DOES need protecting
 * against is a FAST re-selection: the user selects node A, its measure
 * request goes out, then selects node B before A's request resolves. If A's
 * late resolution were applied naively, B's Properties panel would briefly
 * show A's values under B's selection — a real correctness bug, not a
 * cosmetic flicker.
 *
 * The fix is a monotonic generation counter in a plain `useRef` (read/written
 * only inside the effect, never during render — a legitimate ref use, not a
 * `useMutableBox` case, see that hook's own doc for the distinction): each
 * firing of the effect bumps the counter and captures its own value; when the
 * request settles, the resolve/reject handler only applies the result if the
 * counter still matches what it captured. A's late resolution finds the
 * counter has moved on to B's generation and silently drops itself — B's
 * request (or B's `active === false` no-op) owns the state from then on.
 *
 * ## Why the previous value survives a re-fetch
 *
 * `value` is deliberately NOT reset to `null` while a new request is in
 * flight — only `isLoading` flips. A `null` intermediate would flicker every
 * section back to "can't compute yet" on every re-selection and on every
 * keystroke-driven re-measure, which is worse than briefly showing the
 * PREVIOUS node/keystroke's values under a `isLoading: true` banner. Callers
 * that need to know "is this actually current" read `isLoading`.
 *
 * ## camelCase in, camelCase out — kebab-case only crosses the wire
 *
 * Every existing caller of `useFrameComputedStyleValues`/
 * `useInspectComputedStyle` curates its property list in the SAME camelCase
 * vocabulary the portal branch's direct `CSSStyleDeclaration` accessor uses
 * (`flexDirection`, `backgroundColor`, ...) — `ALL_CURATED_CSS_PROPERTIES`,
 * `AlignSection.tsx`'s `['display', 'flexDirection']`, and both of
 * `ConstraintsDiagram.tsx`'s lists are all camelCase. The `measure` wire
 * message and both adapters' own `getPropertyValue` calls
 * (`runtime.ts`/`PortalFrameAdapter.ts`'s shared `DEFAULT_MEASURED_PROPERTIES`)
 * use kebab-case, because `getPropertyValue` is the only computed-style
 * accessor available on a plain CSS property-value map read over the wire.
 * This hook is the one place that bridges the two — converting the request
 * list to kebab-case before it crosses `preferredRenderedCanvasNode`, then
 * converting the reply's keys back to camelCase — so every downstream reader
 * (the dispatcher in `useInspectComputedStyle.ts`, and everything past it)
 * only ever sees the camelCase vocabulary it already indexes by.
 */
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { camelToKebabCssProperty } from '@core/css-codemods'
import { isBridgeFrameAdapter } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { listFrameAdapters } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { preferredRenderedCanvasNode } from '@site/canvas/canvasNodeLookup'

/**
 * True when at least one registered, mounted canvas frame for `breakpointId`
 * is a Tier 2 bridge frame — i.e. the node/frame this hook is asked about can
 * only be answered by the async `postMessage` path, never the portal DOM
 * read.
 *
 * Uses `isBridgeFrameAdapter` (from `BridgeFrameAdapter.ts`), never
 * `isPortalFrameAdapter` (from `PortalFrameAdapter.ts`) — `meta-10`'s own
 * import-cycle finding (`PortalFrameAdapter.ts` carries a store-import chain
 * that `BridgeFrameAdapter.ts` does not) is the reason to keep that
 * direction consistent everywhere a mode check is needed, even though this
 * file doesn't sit in the same import path that originally tripped the
 * cycle — cheap insurance, same precedent.
 */
export function hasBridgeFrameFor(breakpointId: string): boolean {
  for (const [frame, adapter] of listFrameAdapters()) {
    if (isBridgeFrameAdapter(adapter) && frame.getAttribute('data-breakpoint-id') === breakpointId) {
      return true
    }
  }
  return false
}

export interface BridgeComputedValuesResult {
  value: Record<string, string> | null
  isLoading: boolean
}

/** camelCase property name -> its kebab-case wire form, memoized nowhere — a handful of string replaces per request is not worth caching. */
function toWireProperties(properties: ReadonlyArray<string>): string[] {
  return properties.map(camelToKebabCssProperty)
}

/** Re-keys a `measure:result`'s kebab-case computed-style map back to the caller's own camelCase property names, positionally (both arrays share the same order and length by construction — see `toWireProperties`). */
function fromWireComputedStyle(
  camelCaseProperties: ReadonlyArray<string>,
  wireComputedStyle: Record<string, string>,
): Record<string, string> {
  const kebabProperties = toWireProperties(camelCaseProperties)
  const result: Record<string, string> = {}
  camelCaseProperties.forEach((camel, index) => {
    result[camel] = wireComputedStyle[kebabProperties[index]!] ?? ''
  })
  return result
}

/**
 * Called UNCONDITIONALLY from both of `useInspectComputedStyle.ts`'s exported
 * hooks (Rules of Hooks) — `active` gates whether its effect body does
 * anything. For every Tier 0/1 render `active` is `false` forever (no
 * `BridgeFrameAdapter` is ever registered outside a `documentMode='bridge'`
 * frame), so this hook mounts a permanently inert `useState`/`useRef`/
 * `useEffect` triple on that path — zero logic executed, zero observable
 * difference — the same "always-mounted, mode-gated no-op" pattern
 * `useIframeFrameAutoHeight.ts`'s own bridge branch already uses.
 */
export function useBridgeComputedValues(
  nodeId: string | null,
  breakpointId: string,
  properties: ReadonlyArray<string>,
  active: boolean,
): BridgeComputedValuesResult {
  const [value, setValue] = useState<Record<string, string> | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const generationRef = useRef(0)

  // `react-hooks/set-state-in-effect` requires the actual `setState` calls
  // to be reached through an Effect Event, not called directly in the
  // effect body — same posture `useAsyncResource.ts`'s own `runLoad`
  // already takes. Every value the request needs is passed as a parameter
  // (not read off the closure) so it stays the exact value the effect
  // captured when it fired, not whatever `useEffectEvent`'s "always latest"
  // semantics would otherwise substitute.
  const startMeasurement = useEffectEvent(
    (
      currentNodeId: string,
      currentBreakpointId: string,
      currentProperties: ReadonlyArray<string>,
      generation: number,
      isCancelled: () => boolean,
    ) => {
      setIsLoading(true)
      void preferredRenderedCanvasNode(
        currentNodeId,
        currentBreakpointId,
        toWireProperties(currentProperties),
      ).then(
        (result) => {
          if (isCancelled() || generationRef.current !== generation) return
          setValue(result ? fromWireComputedStyle(currentProperties, result.computedStyle) : null)
          setIsLoading(false)
        },
        () => {
          // Timeout or transport failure — keep the previous value, silently
          // (BridgeFrameAdapter.measure() already bounds this; there is
          // nothing new to surface here beyond "not loading anymore").
          if (isCancelled() || generationRef.current !== generation) return
          setIsLoading(false)
        },
      )
    },
  )

  useEffect(() => {
    if (!active || !nodeId) return

    const generation = generationRef.current + 1
    generationRef.current = generation
    let cancelled = false

    startMeasurement(nodeId, breakpointId, properties, generation, () => cancelled)

    return () => {
      cancelled = true
    }
    // `properties` is compared by reference, not deep-equality: callers that
    // pass a stable array (module-level constants like
    // ALL_CURATED_CSS_PROPERTIES) get a stable effect; callers that pass an
    // inline literal (AlignSection/ConstraintsDiagram's small, fixed lists)
    // re-fire on every render of that caller, which is a correctness no-op
    // (the generation guard drops every earlier in-flight request) and not
    // this hook's job to work around.
  }, [nodeId, breakpointId, properties, active])

  return { value, isLoading }
}
