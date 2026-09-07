/**
 * canvasCaptureSettle — the settle predicate behind every PNG export.
 *
 * The defect these pin: a page whose image 404s, whose web font never arrives,
 * or whose DOM never stops mutating used to burn the whole 20 s budget and then
 * come back as a FAILED capture —
 *
 *     "onboarding" did not finish rendering within 20000ms — its preview data,
 *     fonts, or images never settled.
 *
 * The fixtures below are exactly the shapes named in that report: a 404 image,
 * a font that never resolves, and a document that keeps mutating. Every one of
 * them must now produce a SETTLED-or-warned result inside its own bound, never
 * a refusal and never the outer 20 s wait.
 *
 * happy-dom has no network, so an `<img>` is driven directly: `complete` is
 * stubbed (an own property shadows the prototype accessor — the same technique
 * `useIframeFrameAutoHeight.test.tsx` uses for `scrollHeight`) and `load` /
 * `error` are dispatched by the test.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  CAPTURE_SETTLE_TIMEOUT_MS,
  DOM_QUIET_MS,
  MODULE_REGISTRATION_BUDGET_MS,
  settleCaptureDocument,
  waitForDocumentQuiet,
  waitForImagesSettled,
  waitForPromise,
} from '../canvasCaptureSettle'

afterEach(() => {
  document.body.innerHTML = ''
})

/** An `<img>` in a named load state. `complete` is what the settle rule reads. */
function appendImage(state: 'loaded' | 'failed' | 'pending'): HTMLImageElement {
  const image = document.createElement('img')
  image.setAttribute('src', `/fixture-${state}.png`)
  Object.defineProperty(image, 'complete', { value: state !== 'pending', configurable: true })
  Object.defineProperty(image, 'naturalWidth', { value: state === 'loaded' ? 120 : 0, configurable: true })
  document.body.appendChild(image)
  return image
}

/**
 * A stand-in `Document` whose MutationObserver reports a mutation every
 * `churnMs`, forever.
 *
 * A real `document` cannot express "never stops mutating" in this test env:
 * happy-dom delivers MutationObserver records in ~150 ms batches (measured: 30
 * attribute writes over 300 ms produced 2 callbacks), so a 32 ms quiet window
 * always wins no matter how fast the test churns. Chromium delivers per
 * microtask. Faking the OBSERVER — the one thing `waitForDocumentQuiet` reads
 * off the document — tests the timeout branch against its real contract instead
 * of against happy-dom's batching.
 */
function churningDocument(churnMs: number): { document: Document; stop: () => void } {
  const intervals = new Set<ReturnType<typeof setInterval>>()
  class ChurnObserver {
    #interval: ReturnType<typeof setInterval> | null = null
    constructor(private readonly callback: () => void) {}
    observe(): void {
      this.#interval = setInterval(() => this.callback(), churnMs)
      intervals.add(this.#interval)
    }
    disconnect(): void {
      if (this.#interval === null) return
      clearInterval(this.#interval)
      intervals.delete(this.#interval)
      this.#interval = null
    }
  }
  const fake = {
    documentElement: document.documentElement,
    defaultView: { MutationObserver: ChurnObserver },
    querySelectorAll: () => [],
    fonts: undefined,
  } as unknown as Document
  return {
    document: fake,
    stop: () => {
      for (const interval of intervals) clearInterval(interval)
      intervals.clear()
    },
  }
}

/** Mark a pending image finished, the way the browser would. */
function finishImage(image: HTMLImageElement, how: 'load' | 'error'): void {
  Object.defineProperty(image, 'complete', { value: true, configurable: true })
  Object.defineProperty(image, 'naturalWidth', { value: how === 'load' ? 120 : 0, configurable: true })
  image.dispatchEvent(new Event(how))
}

describe('waitForImagesSettled', () => {
  it('treats an image that 404ed as settled, and counts it as failed', async () => {
    appendImage('loaded')
    appendImage('failed')

    const result = await waitForImagesSettled(document, new AbortController().signal, 50)

    expect(result.outcome).toBe('ok')
    expect(result.failed).toBe(1)
    expect(result.stillLoading).toBe(0)
  })

  it('counts an `error` event as settled, exactly like `load`', async () => {
    const broken = appendImage('pending')
    const good = appendImage('pending')

    const pending = waitForImagesSettled(document, new AbortController().signal, 2_000)
    finishImage(broken, 'error')
    finishImage(good, 'load')
    const result = await pending

    // The point of the whole fix: `error` released the wait. If it did not,
    // this resolves `timeout` two seconds later instead.
    expect(result.outcome).toBe('ok')
    expect(result.failed).toBe(1)
  })

  it('gives up on a genuinely hanging image after its own budget, not the outer one', async () => {
    appendImage('pending')

    const started = Date.now()
    const result = await waitForImagesSettled(document, new AbortController().signal, 60)

    expect(result.outcome).toBe('timeout')
    expect(result.stillLoading).toBe(1)
    expect(Date.now() - started).toBeLessThan(CAPTURE_SETTLE_TIMEOUT_MS)
  })

  it('is instantly ok for a document with no images', async () => {
    const result = await waitForImagesSettled(document, new AbortController().signal, 50)
    expect(result).toEqual({ outcome: 'ok', failed: 0, stillLoading: 0 })
  })

  it('reports `aborted` — not `timeout` — when the caller goes away', async () => {
    appendImage('pending')
    const controller = new AbortController()
    controller.abort()

    const result = await waitForImagesSettled(document, controller.signal, 50)
    expect(result.outcome).toBe('aborted')
  })
})

describe('waitForPromise', () => {
  it('counts a REJECTED promise as settled — a failed font load will not change the pixels again', async () => {
    const outcome = await waitForPromise(Promise.reject(new Error('missing woff2')), new AbortController().signal, 500)
    expect(outcome).toBe('ok')
  })

  it('times out on a promise that never settles instead of hanging', async () => {
    const never = new Promise<void>(() => {})
    const outcome = await waitForPromise(never, new AbortController().signal, 40)
    expect(outcome).toBe('timeout')
  })
})

describe('waitForDocumentQuiet', () => {
  it('resolves ok once mutations stop', async () => {
    const outcome = await waitForDocumentQuiet(document, new AbortController().signal, 2_000)
    expect(outcome).toBe('ok')
  })

  it('times out on a document that never stops mutating', async () => {
    const churn = churningDocument(DOM_QUIET_MS / 4)
    try {
      const outcome = await waitForDocumentQuiet(churn.document, new AbortController().signal, 150)
      expect(outcome).toBe('timeout')
    } finally {
      churn.stop()
    }
  })
})

describe('settleCaptureDocument', () => {
  it('settles a clean document with no warnings', async () => {
    appendImage('loaded')

    const result = await settleCaptureDocument({
      document,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    })

    expect(result).toEqual({ settled: true, stalledPhase: null, warnings: [], aborted: false })
  })

  it('settles a document with a broken image, naming it as a warning rather than failing', async () => {
    appendImage('loaded')
    appendImage('failed')

    const result = await settleCaptureDocument({
      document,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    })

    expect(result.settled).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.warnings).toEqual(['1 image failed to load and is missing from this capture.'])
  })

  it('pluralises the broken-image warning', async () => {
    appendImage('failed')
    appendImage('failed')

    const result = await settleCaptureDocument({
      document,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    })

    expect(result.warnings).toEqual(['2 images failed to load and are missing from this capture.'])
  })

  it('names `dom-quiet` and returns inside its own bound when the DOM never stops changing', async () => {
    const churn = churningDocument(DOM_QUIET_MS / 4)
    try {
      const started = Date.now()
      const result = await settleCaptureDocument({
        document: churn.document,
        signal: new AbortController().signal,
        timeoutMs: 300,
      })

      expect(result.settled).toBe(false)
      expect(result.aborted).toBe(false)
      expect(result.stalledPhase).toBe('dom-quiet')
      expect(result.warnings).toEqual(['This screen never stopped changing, so it was captured mid-render.'])
      // The whole point: it did NOT ride the outer 20 s bound.
      expect(Date.now() - started).toBeLessThan(CAPTURE_SETTLE_TIMEOUT_MS)
    } finally {
      churn.stop()
    }
  })

  it('does not settle before the project\'s module registration lands', async () => {
    // The PNG-export defect one layer down: `alm.*`/`pkg.*` components register
    // asynchronously, and a frame photographed before they do is a picture of
    // placeholders. The shutter must wait.
    let registered: (() => void) | null = null
    const moduleRegistration = new Promise<void>((resolve) => { registered = resolve })
    let settledAt: number | null = null

    const settle = settleCaptureDocument({
      document,
      moduleRegistration,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    }).then((result) => {
      settledAt = Date.now()
      return result
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(settledAt).toBeNull() // still waiting on registration, not on the DOM

    const releasedAt = Date.now()
    registered!()
    const result = await settle

    expect(result.settled).toBe(true)
    expect(result.warnings).toEqual([])
    expect(settledAt!).toBeGreaterThanOrEqual(releasedAt)
  })

  it('names the module bundle in a warning when it never arrives, and captures anyway', async () => {
    // Bounded like every other phase: a package that will never bundle has
    // already reached its final pixels, so the honest answer is the photograph
    // plus a NAMED reason — never a refusal, and never a silent placeholder.
    //
    // The bound here is the caller's outer deadline rather than
    // `MODULE_REGISTRATION_BUDGET_MS`, because the phase takes whichever is
    // smaller (a capture cannot spend budget it does not have). In production
    // the two are 10 s inside 20 s, so the remaining phases still run; at the
    // 400 ms used here the deadline is spent, and the report says BOTH things.
    const started = Date.now()
    const result = await settleCaptureDocument({
      document,
      moduleRegistration: new Promise<void>(() => {}), // never resolves
      signal: new AbortController().signal,
      timeoutMs: 400,
    })

    expect(result.aborted).toBe(false)
    expect(result.warnings[0]).toContain('package components had not finished registering')
    expect(result.warnings[0]).toContain('captured as a placeholder')
    expect(Date.now() - started).toBeLessThan(MODULE_REGISTRATION_BUDGET_MS)
  })

  it('reports `modules` as the phase when the caller aborts during registration', async () => {
    const controller = new AbortController()
    const result = settleCaptureDocument({
      document,
      moduleRegistration: new Promise<void>(() => {}),
      signal: controller.signal,
      timeoutMs: 3_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    expect(await result).toMatchObject({ aborted: true, stalledPhase: 'modules', warnings: [] })
  })

  it('reports `aborted` for a caller that went away, and never as a warning', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await settleCaptureDocument({ document, signal: controller.signal, timeoutMs: 500 })

    expect(result.aborted).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('waits for the preview-data barrier, and releases when a tracked request REJECTS', async () => {
    let releaseTracked: (() => void) | null = null
    const tracked = new Promise<void>((_resolve, reject) => {
      releaseTracked = () => reject(new Error('preview lookup 500'))
    })

    let pending = 1
    let revision = 1
    const listeners = new Set<() => void>()
    const previewReadiness = {
      track: () => {},
      waitUntilIdle: (signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          if (pending === 0) { resolve(true); return }
          const onIdle = () => resolve(true)
          listeners.add(onIdle)
          signal.addEventListener('abort', () => resolve(false), { once: true })
        }),
      pendingCount: () => pending,
      revision: () => revision,
    }
    void tracked.catch(() => {
      pending = 0
      revision += 1
      for (const listener of listeners) listener()
      listeners.clear()
    })

    const settling = settleCaptureDocument({
      document,
      previewReadiness,
      signal: new AbortController().signal,
      timeoutMs: 3_000,
    })
    releaseTracked?.()
    const result = await settling

    expect(result.settled).toBe(true)
    expect(result.aborted).toBe(false)
  })
})
