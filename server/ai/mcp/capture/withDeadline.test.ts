import { describe, expect, it } from 'bun:test'
import { DeadlineExceededError, withDeadline } from './withDeadline'
import { captureEntryUrl, viteDevOrigin } from './captureOrigin'

describe('withDeadline', () => {
  it('passes through a result that arrives in time', async () => {
    expect(await withDeadline(Promise.resolve(7), 1_000, 'Step')).toBe(7)
  })

  it('rejects with a named error when the work never settles', async () => {
    const never = new Promise<number>(() => {})
    const err = await withDeadline(never, 20, 'Launching the capture browser').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeadlineExceededError)
    expect((err as Error).message).toContain('Launching the capture browser')
  })

  it('propagates the work\'s own rejection untouched', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1_000, 'Step')).rejects.toThrow('boom')
  })
})

describe('capture origin in dev', () => {
  // `STATIC_DIR` points at a directory with no index.html, i.e. "not built".
  const notBuilt = { STATIC_DIR: './definitely-not-a-build-dir' }

  it('defaults to the standard Vite port on loopback', () => {
    expect(viteDevOrigin({})).toBe('http://127.0.0.1:5173')
  })

  it('follows the port the dev supervisor started Vite on, so a share/thumbnail on a non-default stack is not photographed from a dead port', () => {
    expect(captureEntryUrl('tok', { ...notBuilt, VITE_PORT: '5174' })).toBe(
      'http://127.0.0.1:5174/agent-capture.html?token=tok',
    )
  })
})
