/**
 * Global test setup — runs before every test file via bunfig.toml preload.
 *
 * Sets up a happy-dom environment so that @testing-library/react and
 * other DOM-dependent code can run in bun test without a real browser.
 *
 * Uses GlobalWindow (not Window) so that JS built-ins (SyntaxError, TypeError,
 * etc.) are available on the window object — required by @testing-library/dom's
 * querySelectorAll implementation.
 */
import { GlobalWindow, MutationObserver as HappyMutationObserver, PropertySymbol } from 'happy-dom'

// happy-dom auto-fetches and parses every `<link rel="stylesheet">` inserted
// into the document — including the Google Fonts CSS that
// `loadFontPreview()` injects from `src/core/fonts/preview.ts`. The fetched
// CSS contains selectors happy-dom's parser can't represent, and the
// internal SyntaxError it throws crashes on `new this.window.SyntaxError(...)`
// in deno-style noise between test files (the link load is async and outlives
// the test that triggered it). Disabling CSS file loading silences the noise
// without affecting any assertion — no test actually inspects the parsed
// CSSRules from a `<link>` tag.
//
// Equivalent: `disableJavaScriptFileLoading: true` also disables the
// JavaScript loader that would otherwise fetch `<script src>` URLs from
// canvas previews.
const happyWindow = new GlobalWindow({
  url: 'http://localhost/',
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
  },
})

// ---------------------------------------------------------------------------
// Keep happy-dom's MutationObserver callbacks alive across a GC.
//
// happy-dom registers each observation as `{ options, callback: new WeakRef(
// (record) => listener.report(record)) }` (`MutationObserverListener`'s
// constructor) and pushes that object onto the target node's listener array.
// Nothing else holds a strong reference to that arrow function — so the
// moment Bun's GC runs, `callback.deref()` returns `undefined` and
// `Node[PropertySymbol.reportMutation]` silently skips the listener. The
// observer object itself is still alive and still "connected"; it just never
// fires again, and `takeRecords()` returns `[]`.
//
// That is not a behaviour any real browser has, and it breaks exactly the
// code that observes long-lived DOM: a canvas injector attaches its
// MutationObserver in a mount effect, the test then spends seconds in
// `waitFor` (allocating enough to trigger a collection), and the mutation the
// test finally makes is never delivered. It looks like a product bug in the
// injector and is not — verified directly: an observer that fires normally
// stops firing across a single explicit `Bun.gc(true)`.
//
// The repair pins the derefed closures for as long as the observer is
// observing. A `WeakMap` keyed by the observer is the right lifetime: happy-dom
// keeps every connected observer in `window[PropertySymbol.mutationObservers]`
// and removes it on `disconnect()`, so the pinned closures become collectable
// again at exactly the moment the observer legitimately stops mattering.
//
// Patched on the shared implementation class (`happy-dom`'s exported
// `MutationObserver`), NOT on `happyWindow.MutationObserver` — every window,
// including each `<iframe>`'s, gets its own empty subclass of that one
// implementation (`WindowContextClassExtender`), so patching the base covers
// the iframe canvas frames too, which is where this actually bites.
{
  type MutationListenerRecord = { callback?: { deref(): unknown } }
  type ObservableNode = Record<symbol, unknown>

  const observeProto = HappyMutationObserver.prototype as unknown as {
    observe(target: unknown, options?: unknown): void
  }
  const originalObserve = observeProto.observe
  const pinnedCallbacks = new WeakMap<object, unknown[]>()

  observeProto.observe = function patchedObserve(target: unknown, options?: unknown): void {
    originalObserve.call(this, target, options)
    const listeners = (target as ObservableNode | null)?.[PropertySymbol.mutationListeners]
    if (!Array.isArray(listeners)) return
    let pinned = pinnedCallbacks.get(this as object)
    if (!pinned) {
      pinned = []
      pinnedCallbacks.set(this as object, pinned)
    }
    for (const listener of listeners as MutationListenerRecord[]) {
      const callback = listener?.callback?.deref()
      if (callback && !pinned.includes(callback)) pinned.push(callback)
    }
  }
}

// Assign the window and document globals first — other globals are derived from these
;(globalThis as Record<string, unknown>).window = happyWindow
;(globalThis as Record<string, unknown>).document = happyWindow.document

// Assign all remaining browser globals from the happy-dom GlobalWindow.
// This ensures built-in constructors (SyntaxError, HTMLElement, etc.) are
// accessible both as standalone globals AND as window.* properties.
const GLOBALS_TO_COPY = [
  'navigator',
  'location',
  'history',
  'screen',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  // happy-dom implements PointerEvent + set/has/releasePointerCapture, but
  // doesn't put PointerEvent on the global scope by default — needed for
  // tests that drive a real drag gesture (e.g. ScrubInput's scrub-to-change
  // interaction) via @testing-library's `fireEvent.pointerDown/Move/Up`.
  'PointerEvent',
  'FocusEvent',
  'InputEvent',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'DOMParser',
  'XMLSerializer',
  'URLSearchParams',
  'URL',
  'FormData',
  'Blob',
  'File',
  'FileReader',
  'Headers',
  'Request',
  'Response',
  'fetch',
  'AbortController',
  'AbortSignal',
  'crypto',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'performance',
  'localStorage',
  'sessionStorage',
  'SyntaxError',
  'TypeError',
  'RangeError',
  'DOMException',
  'Text',
  'Comment',
  'DocumentFragment',
  'Range',
  'Selection',
  'Storage',
  'CSSStyleDeclaration',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'HTMLAnchorElement',
  'HTMLFormElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'SVGElement',
] as const

for (const key of GLOBALS_TO_COPY) {
  const val = (happyWindow as Record<string, unknown>)[key]
  if (val !== undefined) {
    ;(globalThis as Record<string, unknown>)[key] = val
  }
}

// ---------------------------------------------------------------------------
// Default user-preference fetches to the "never set" envelope.
//
// Admin surfaces load user preferences on mount (e.g. the module-inserter
// favourites via `useModuleInserterPreference` → `getUserPreference`), which
// fires a real `fetch` to `/admin/api/cms/me/preferences/<key>`. In tests that
// hits `http://localhost` and rejects with ECONNREFUSED. Because the
// preference store is a module-level singleton whose load promise can outlive
// the component that triggered it, that rejection surfaces during a LATER
// test's `cleanup()` as an `AggregateError` — a cross-test flake that depends
// on render timing (it was masked while canvas frames mounted slowly, and
// reappeared once they mount synchronously).
//
// Returning the server's "never set" signal (`{ value: null }`) makes every
// such load resolve cleanly to the caller's own default, with no network call.
// Tests that need specific preference data still override `globalThis.fetch`
// in their own setup; `getUserPreference` callers that inject a `fetchImpl`
// bypass this entirely.
{
  const realFetch = globalThis.fetch
  const PREFERENCES_PATH = '/admin/api/cms/me/preferences/'
  ;(globalThis as Record<string, unknown>).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const method = (init?.method ?? (input as Request).method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.includes(PREFERENCES_PATH)) {
      return new Response(JSON.stringify({ value: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return realFetch(input, init)
  }) as typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// Tame DOM serialization in failure output.
//
// A happy-dom node is deeply circular (`ownerDocument` → every element →
// `affectsCache` arrays of thousands → back to the document). When ANY
// assertion fails or a component throws with a node in scope, bun's error
// reporter recurses the whole tree and prints MILLIONS of lines for a single
// failing test — drowning the run and making the real failure unfindable.
//
// Registering a custom inspector on the happy-dom `Node` prototype collapses
// every node to a one-line tag summary in inspect/expect output. This affects
// ONLY serialization — structural equality (`toEqual`), queries, and event
// dispatch are untouched (matchers compare the live objects, they don't go
// through inspect). One guard fixes every DOM-rendering test at once.
{
  const inspectCustom = Symbol.for('nodejs.util.inspect.custom')
  const NodeCtor = (happyWindow as unknown as { Node?: { prototype: object } }).Node
  if (NodeCtor?.prototype) {
    Object.defineProperty(NodeCtor.prototype, inspectCustom, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(this: Record<string, unknown>): string {
        try {
          const nodeType = this['nodeType']
          if (nodeType === 1) {
            const tag = String(this['tagName'] ?? this['localName'] ?? 'element').toLowerCase()
            const id = this['id'] ? `#${String(this['id'])}` : ''
            const className = this['className']
            const cls =
              typeof className === 'string' && className.trim()
                ? `.${className.trim().split(/\s+/).join('.')}`
                : ''
            return `<${tag}${id}${cls}>`
          }
          if (nodeType === 3) return `#text ${JSON.stringify(String(this['textContent'] ?? '').slice(0, 60))}`
          if (nodeType === 8) return '#comment'
          if (nodeType === 9) return '#document'
          if (nodeType === 11) return '#document-fragment'
          return `[Node nodeType=${String(nodeType)}]`
        } catch {
          return '[Node]'
        }
      },
    })
  }
}

// happy-dom does not implement EventSource, but several admin layouts
// (AdminPageLayout, AdminCanvasLayout) construct one on mount via the
// plugin event bridge. Provide a no-op stub so tests can render those
// layouts without each test file needing its own polyfill.
// happy-dom creates fresh `Window` objects for `<iframe>` elements without
// copying the parent's built-in constructors. The canvas now renders each
// breakpoint frame inside an iframe, and selectors run against
// `iframe.contentDocument` from inside the page-tree React subtree. happy-dom
// internally calls `new this.window.SyntaxError(...)` when a selector fails;
// without our polyfill that fires `undefined is not a constructor` and
// crashes the test before any assertion runs. We monkey-patch the iframe
// contentDocument getter to lazily copy parent constructors onto each
// iframe's window so test queries behave the same as the host.
const IFRAME_GLOBAL_KEYS = [
  'SyntaxError',
  'TypeError',
  'RangeError',
  'DOMException',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
] as const

function polyfillIframeWindow(win: unknown): void {
  if (!win || typeof win !== 'object') return
  const target = win as Record<string, unknown>
  for (const key of IFRAME_GLOBAL_KEYS) {
    if (target[key] !== undefined) continue
    const parentValue = (globalThis as Record<string, unknown>)[key]
    if (parentValue !== undefined) target[key] = parentValue
  }
}

{
  const iframeProto = (happyWindow as unknown as { HTMLIFrameElement?: { prototype: object } })
    .HTMLIFrameElement?.prototype
  if (iframeProto) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(iframeProto, 'contentDocument')
    if (originalDescriptor?.get) {
      Object.defineProperty(iframeProto, 'contentDocument', {
        configurable: true,
        get(this: HTMLIFrameElement) {
          const doc = originalDescriptor.get!.call(this)
          if (doc) polyfillIframeWindow((doc as Document).defaultView)
          return doc
        },
      })
    }
  }
}

if (typeof (globalThis as { EventSource?: unknown }).EventSource === 'undefined') {
  class StubEventSource {
    readonly url: string
    readonly withCredentials: boolean
    readonly readyState: number = 1
    onopen: ((this: StubEventSource, ev: Event) => unknown) | null = null
    onmessage: ((this: StubEventSource, ev: MessageEvent) => unknown) | null = null
    onerror: ((this: StubEventSource, ev: Event) => unknown) | null = null
    constructor(url: string | URL, init?: { withCredentials?: boolean }) {
      this.url = typeof url === 'string' ? url : url.toString()
      this.withCredentials = Boolean(init?.withCredentials)
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean { return true }
    close(): void {}
  }
  ;(globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown
}

// ---------------------------------------------------------------------------
// Async budgets, declared once for the whole suite.
//
// Both numbers exist because CI runs on a shared 2-4 vCPU Linux runner that is
// roughly 5-10x slower than a developer laptop at mounting this suite's real
// iframes, ResizeObservers and canvas frames. Every budget below was picked so
// that the SLOWEST honest test on that runner still fits, because in this
// suite a blown budget is not a local failure — see the act() note further
// down for why one timed-out test used to take the entire run with it.
//
// - `asyncUtilTimeout` (@testing-library/dom `waitFor` / `findBy*`) defaults to
//   1000ms. Canvas suites that mount a breakpoint frame routinely land at
//   1005-1030ms on a laptop, i.e. they were already passing by ~0ms of margin
//   and failed outright on the runner. 5000ms.
// - `setDefaultTimeout` (bun's per-test budget) defaults to 5000ms, which is
//   the SAME order as the waitFor budget above — so a genuinely failing
//   `waitFor` would burn the whole test budget and abandon the test mid-await
//   instead of failing cleanly with a useful message. 20000ms keeps a
//   comfortable multiple between the two, so a bad `waitFor` always reports
//   itself rather than tripping the outer timeout.
//
// Raise these HERE, never per test: a per-file override only moves the cliff.
{
  const { setDefaultTimeout } = await import('bun:test')
  const { configure } = await import('@testing-library/dom')
  configure({ asyncUtilTimeout: 5_000 })
  setDefaultTimeout(20_000)
}

// ---------------------------------------------------------------------------
// Repair a leaked React act() scope between tests.
//
// This is the single highest-leverage guard in the file. React's `act()` keeps
// two pieces of module-private state: `actQueue` (the work it will flush) and
// `actScopeDepth` (how many act scopes are open). Both are unwound in the
// `.then()` handlers of the promise `await act(async () => …)` returns.
//
// When bun's per-test timeout fires, it abandons the test's async frame — so
// that promise NEVER settles, so those handlers never run, so `actScopeDepth`
// stays at 1 and `actQueue` stays non-null FOR THE REST OF THE PROCESS. React
// then takes the `prevActScopeDepth !== 0` branch on every later render: work
// is pushed onto the orphaned queue and never flushed. Every subsequent
// `render()` in every subsequent FILE commits nothing — RTL reports an empty
// `<body><div /></body>` and `renderHook` hands back `result.current === null`.
//
// That is not hypothetical: it is what turned ~30 real CI failures into 666.
// One agent-canvas test exceeding 5000ms on the runner bricked React for the
// 500+ files that ran after it. `--parallel=4` (see bunfig.toml) contains the
// blast radius to one file, and the budgets above stop the timeout happening
// at all — this guard is the third line, so that a future slow test degrades
// to ONE failure instead of a suite-wide wipeout.
//
// The repair: wrap `React.act` so an async callback's thenable is replaced by
// one we can settle ourselves, and resolve any still-pending wrapper in
// `afterEach`. Resolving (not rejecting) is deliberate — it drives React's own
// fulfilment path, which calls `popActScope` and flushes the queue, restoring
// exactly the state React would have reached on its own. `thrownErrors` is a
// shared array on the same internals object, so an abandoned act can also
// deposit an error that surfaces inside an unrelated later test; clear it too.
//
// Must run BEFORE the `@testing-library/react` import below: RTL copies
// `React.act` once at module load (`act-compat.js`), so a later patch is
// invisible to it. It also has to go through `require`, not `import` — an ESM
// namespace object is frozen, and the mutable CJS `module.exports` is the same
// object RTL reads from.
{
  const { afterEach } = await import('bun:test')
  const { createRequire } = await import('node:module')

  type ActInternals = { thrownErrors: unknown[] }
  type ActCallback = () => unknown
  type ActFn = (callback: ActCallback) => unknown
  type ReactCjs = {
    act?: ActFn
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: ActInternals
  }

  const reactModule = createRequire(import.meta.url)('react') as ReactCjs
  const internals = reactModule.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const realAct = reactModule.act

  if (typeof realAct === 'function') {
    let abandonedScopeSettlers: Array<() => void> = []

    reactModule.act = function actWithLeakRepair(callback: ActCallback): unknown {
      return realAct(() => {
        const result = callback()
        const isThenable =
          result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function'
        if (!isThenable) return result

        return new Promise((resolve, reject) => {
          let settled = false
          abandonedScopeSettlers.push(() => {
            if (settled) return
            settled = true
            resolve(undefined)
          })
          ;(result as PromiseLike<unknown>).then(
            (value) => {
              settled = true
              resolve(value)
            },
            (error: unknown) => {
              settled = true
              reject(error)
            },
          )
        })
      })
    }

    afterEach(() => {
      const settlers = abandonedScopeSettlers
      abandonedScopeSettlers = []
      for (const settle of settlers) settle()
      if (internals) internals.thrownErrors.length = 0
    })
  }
}

// ---------------------------------------------------------------------------
// Global React Testing Library cleanup after every test.
//
// @testing-library/react auto-registers an `afterEach(cleanup)` ONLY when
// `afterEach` is a global (the Jest/Vitest convention). Under `bun test`
// `afterEach` is import-only, so auto-cleanup never installs: any test that
// renders a component and doesn't manually `cleanup()` leaves it mounted, and
// it lingers into the NEXT test file. When a later file's own `cleanup()`
// finally unmounts that stale tree, an effect or in-flight request that
// resolved after the originating test surfaces inside that unrelated test's
// `act()` as an `AggregateError` — a cross-file flake whose victim depends on
// file ordering. Registering cleanup here (from the preload, so it applies to
// every file) restores the intended per-test isolation. `cleanup()` is a no-op
// when nothing is mounted, so non-React tests are unaffected.
//
// Imported dynamically so it runs AFTER the happy-dom globals above are
// installed — a static top-level import would be hoisted and pull in React
// before `document` exists.
{
  const { afterEach } = await import('bun:test')
  const { cleanup } = await import('@testing-library/react')
  const { __resetToastBusForTests } = await import('@ui/components/Toast/toastBus')
  afterEach(() => {
    cleanup()
    __resetToastBusForTests()
    document.getElementById('toast-root')?.remove()
  })
}

// ---------------------------------------------------------------------------
// The Studio workspace root, for the whole suite.
//
// `resolveProjectDir` containment-checks every client-supplied `dir` against
// `projectsRootDir()` (W10) — the guard that stops an agent in project A from
// naming project B, `~/.ssh`, or anywhere else on disk. Roughly fifty server
// test files build their fixture project with `mkdtempSync(join(tmpdir(),
// …))`, i.e. a project that is its own root, with no `studio-workspace/`
// above it — so without this every one of them would be refused.
//
// Declaring the fact ONCE, here, says the true thing: in this suite the
// studio workspace root IS the OS temp directory. The alternative is fifty
// copies of the same `process.env` dance, which is fifty chances to write it
// slightly differently and one more thing every new fixture has to remember.
//
// A file that needs its own root (a multi-project fixture, or one asserting
// the containment refusal itself) still sets `STUDIO_WORKSPACE_DIR` in its
// own `beforeAll` and restores it after — `projectsRootDir()` re-reads the
// variable on every call precisely so that works.
{
  const { tmpdir } = await import('node:os')
  process.env.STUDIO_WORKSPACE_DIR ??= tmpdir()
}
