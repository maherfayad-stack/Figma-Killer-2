/**
 * Z5 — the in-frame runtime's four error taps and the two sender-side bounds.
 *
 * Drives the REAL listeners `createStudioRuntimeBridge` installs on the
 * document's own window (not a stub), because the thing most likely to be wrong
 * is which phase a listener is on and whether a patch is restored — neither of
 * which a stub would exercise. What is NOT covered here, per `live-04`'s
 * standing note: a real cross-origin `postMessage` round trip. The parent half
 * of that round trip has its own tests
 * (`src/__tests__/canvas/frameAdapter/BridgeFrameAdapter.test.ts`).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createStudioRuntimeBridge, type StudioRuntimeBridge } from '@core/studio-runtime'

const PARENT_ORIGIN = 'https://parent.test'

interface PostedError {
  kind: string
  message: string
  stack?: string
  source?: string
}

function bootBridge() {
  const posted: Array<{ type: string } & Partial<PostedError>> = []
  const fakeWindow = {
    postMessage: (data: unknown) => {
      posted.push((data as { message: { type: string } }).message)
    },
  } as unknown as Window
  const instance = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
  return { instance, errors: () => posted.filter((m): m is { type: 'error' } & PostedError => m.type === 'error') }
}

let bridge: StudioRuntimeBridge | null = null

afterEach(() => {
  bridge?.dispose()
  bridge = null
  document.body.innerHTML = ''
})

describe('runtime error taps — what each tap reports', () => {
  it('an uncaught exception posts kind "exception" with its stack and file:line:col', () => {
    const { instance, errors } = bootBridge()
    bridge = instance

    const thrown = new TypeError('cart is not defined')
    thrown.stack = 'TypeError: cart is not defined\n    at Checkout (/src/Checkout.tsx:42:7)'
    const event = new Event('error') as Event & Record<string, unknown>
    event.message = 'Uncaught TypeError: cart is not defined'
    event.error = thrown
    event.filename = '/src/Checkout.tsx'
    event.lineno = 42
    event.colno = 7
    document.defaultView!.dispatchEvent(event)

    expect(errors()).toHaveLength(1)
    const entry = errors()[0]!
    expect(entry.kind).toBe('exception')
    expect(entry.message).toBe('Uncaught TypeError: cart is not defined')
    expect(entry.stack).toContain('Checkout.tsx:42:7')
    expect(entry.source).toBe('/src/Checkout.tsx:42:7')
  })

  it('a failed <img> load posts kind "resource" — and only the CAPTURE phase can see it, since resource errors do not bubble', () => {
    const { instance, errors } = bootBridge()
    bridge = instance

    const img = document.createElement('img')
    img.setAttribute('src', '/assets/hero.png')
    document.body.appendChild(img)
    img.dispatchEvent(new Event('error'))

    expect(errors()).toHaveLength(1)
    expect(errors()[0]!.kind).toBe('resource')
    expect(errors()[0]!.message).toBe('<img> failed to load /assets/hero.png')
    expect(errors()[0]!.source).toBe('/assets/hero.png')
  })

  it('an unhandled rejection posts kind "unhandledrejection" with the reason rendered as one line', () => {
    const { instance, errors } = bootBridge()
    bridge = instance

    const event = new Event('unhandledrejection') as Event & Record<string, unknown>
    event.reason = new Error('checkout/session 500')
    document.defaultView!.dispatchEvent(event)

    expect(errors()).toHaveLength(1)
    expect(errors()[0]!.kind).toBe('unhandledrejection')
    expect(errors()[0]!.message).toBe('Error: checkout/session 500')
  })

  it('console.error is recorded, passed through, and the EXACT original reference is restored on dispose', () => {
    // Patched on the FRAME's own console (`document.defaultView.console`),
    // which is what the bridge wraps — under happy-dom that is not the same
    // object as the test process's global `console`.
    const frameConsole = document.defaultView!.console
    const native = frameConsole.error
    const seen: unknown[][] = []
    frameConsole.error = ((...args: unknown[]) => {
      seen.push(args)
    }) as Console['error']
    try {
      const { instance, errors } = bootBridge()
      bridge = instance

      frameConsole.error('Warning: each child in a list should have a unique "key" prop.')

      expect(errors()).toHaveLength(1)
      expect(errors()[0]!.kind).toBe('console')
      expect(errors()[0]!.message).toContain('unique "key" prop')
      // Pass-through: the browser console stays the browser console.
      expect(seen).toHaveLength(1)

      instance.dispose()
      bridge = null
      frameConsole.error('after dispose')
      // No longer recorded, still logged — the tap is gone, the console is not.
      expect(errors()).toHaveLength(1)
      expect(seen).toHaveLength(2)
    } finally {
      frameConsole.error = native
    }
  })

  it('a non-ok fetch is recorded and the response is returned unchanged; a rejecting fetch is recorded and rethrown', async () => {
    const frameWindow = document.defaultView!
    const native = frameWindow.fetch
    frameWindow.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes('boom')
        ? Promise.reject(new Error('Failed to fetch'))
        : new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as typeof frameWindow.fetch
    try {
      const { instance, errors } = bootBridge()
      bridge = instance

      const response = await frameWindow.fetch('/api/cart')
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('nope')

      await expect(frameWindow.fetch('/api/boom')).rejects.toThrow('Failed to fetch')

      expect(errors()).toHaveLength(2)
      expect(errors()[0]!.kind).toBe('network')
      expect(errors()[0]!.message).toBe('fetch /api/cart responded 503 Service Unavailable')
      expect(errors()[1]!.message).toContain('fetch /api/boom failed')
    } finally {
      bridge?.dispose()
      bridge = null
      frameWindow.fetch = native
    }
  })
})

describe('runtime error taps — the two sender-side bounds', () => {
  function throwOnce(index: number): void {
    const event = new Event('error') as Event & Record<string, unknown>
    event.message = `boom ${index}`
    document.defaultView!.dispatchEvent(event)
  }

  it('posts at most 10 per second — the rest are dropped at the sender, not queued', () => {
    const { instance, errors } = bootBridge()
    bridge = instance

    for (let i = 0; i < 25; i += 1) throwOnce(i)

    expect(errors()).toHaveLength(10)
    // The FIRST ten, not the last: the first error is almost always the cause.
    expect(errors()[0]!.message).toBe('boom 0')
    expect(errors()[9]!.message).toBe('boom 9')
  })

  it('never posts more than 50 for one document, however long the frame lives', async () => {
    const { instance, errors } = bootBridge()
    bridge = instance

    // Six one-second windows' worth of budget, drained ten at a time. The
    // lifetime cap has to hold across windows or it is only a rate limit.
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < 10; i += 1) throwOnce(round * 10 + i)
      await Bun.sleep(1010)
    }

    expect(errors()).toHaveLength(50)
  }, 15_000)
})
