import { afterEach, describe, expect, it } from 'bun:test'
import { downloadStudioCode, readStudioCodeZip } from '../downloadStudioCode'

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('readStudioCodeZip', () => {
  it('returns the zip blob when the server responds with application/zip', async () => {
    const blob = await readStudioCodeZip({
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'application/zip' },
        }),
    })
    expect(blob.type).toBe('application/zip')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('passes dir through as a query param', async () => {
    let seenUrl = ''
    await readStudioCodeZip({
      dir: '/tmp/my-workspace',
      fetchImpl: async (input) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/zip' } })
      },
    })
    expect(seenUrl).toContain('dir=')
    expect(seenUrl).toContain(encodeURIComponent('/tmp/my-workspace'))
  })

  it('rejects a non-zip MIME type rather than treating the bytes as a zip', async () => {
    await expect(
      readStudioCodeZip({
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: 'Workspace directory not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toThrow()
  })

  it('surfaces the server error envelope for a 404 (missing workspace dir)', async () => {
    const err = await readStudioCodeZip({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'Workspace directory not found: /nope' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('downloadStudioCode', () => {
  it('triggers a browser download named studio-workspace.zip and releases the object URL', async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const clickDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click')
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(window, 'setTimeout')
    let revokedUrl = ''
    let downloadName = ''
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:studio-workspace',
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => {
        revokedUrl = url
      },
    })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: function click(this: HTMLAnchorElement) {
        downloadName = this.download
      },
    })
    Object.defineProperty(window, 'setTimeout', {
      configurable: true,
      value: (handler: TimerHandler) => {
        if (typeof handler === 'function') handler()
        return 1
      },
    })

    try {
      await downloadStudioCode({
        fetchImpl: async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/zip' } }),
      })
      expect(downloadName).toBe('studio-workspace.zip')
      expect(revokedUrl).toBe('blob:studio-workspace')
    } finally {
      restoreProperty(URL, 'createObjectURL', createDescriptor)
      restoreProperty(URL, 'revokeObjectURL', revokeDescriptor)
      restoreProperty(HTMLAnchorElement.prototype, 'click', clickDescriptor)
      restoreProperty(window, 'setTimeout', timeoutDescriptor)
    }
  })
})
