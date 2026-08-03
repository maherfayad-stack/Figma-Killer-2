/**
 * Unit tests for `useDesignReferenceAttachment` — the lossless design-
 * reference attach/upload/remove state machine. HTTP + header-sniffing are
 * mocked at the module boundary (same technique as `McpTab.test.tsx`): the
 * mock is registered with the EXACT relative specifier the hook itself
 * imports, then the hook module is imported afterwards so it binds to the
 * mock.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DesignReferenceMeta } from '@core/ai'

const meta: DesignReferenceMeta = {
  id: 'a1b2c3d4-0000-4000-8000-000000000000',
  ext: 'png',
  relPath: '.studio/references/a1b2c3d4.png',
  label: 'homepage.png',
  mimeType: 'image/png',
  width: 1290,
  height: 8400,
  sizeBytes: 21_000_000,
  contentHash: 'a'.repeat(64),
  createdAt: '2026-08-03T00:00:00.000Z',
}

let fetchImpl = async (): Promise<DesignReferenceMeta | null> => null
let uploadImpl = async (): Promise<DesignReferenceMeta> => meta
let deleteImpl = async (): Promise<void> => {}
let dimensionsImpl = async () => ({ width: 1290, height: 8400 })

mock.module('../../studio/uploadDesignReference', () => ({
  fetchDesignReference: (...args: unknown[]) => fetchImpl(...(args as [])),
  uploadDesignReference: (...args: unknown[]) => uploadImpl(...(args as [])),
  deleteDesignReference: (...args: unknown[]) => deleteImpl(...(args as [])),
}))

mock.module('./designReferenceHeader', () => ({
  readDesignReferenceDimensions: (...args: unknown[]) => dimensionsImpl(...(args as [])),
}))

const { useDesignReferenceAttachment } = await import('./useDesignReferenceAttachment')

function pngFile(name = 'homepage.png'): File {
  return new File([new Uint8Array(1024)], name, { type: 'image/png' })
}

afterEach(() => {
  cleanup()
  fetchImpl = async () => null
  uploadImpl = async () => meta
  deleteImpl = async () => {}
  dimensionsImpl = async () => ({ width: 1290, height: 8400 })
})

describe('useDesignReferenceAttachment', () => {
  it('starts empty when no reference is stored server-side', async () => {
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.reference).toBeNull()
  })

  it('restores an existing server-side reference on mount', async () => {
    fetchImpl = async () => meta
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.reference).toEqual(meta))
  })

  it('treats a failed restore fetch (e.g. the endpoint not existing yet) as "no reference"', async () => {
    fetchImpl = async () => { throw new Error('404') }
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.reference).toBeNull()
  })

  it('attaches a file: shows pending dimensions immediately, then the server-confirmed reference', async () => {
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.attach(pngFile())
    })

    await waitFor(() => expect(result.current.pendingDimensions).toEqual({ width: 1290, height: 8400 }))
    await waitFor(() => expect(result.current.reference).toEqual(meta))
    expect(result.current.uploading).toBe(false)
    expect(result.current.previewUrl).not.toBeNull()
  })

  it('surfaces an upload failure without leaving a phantom reference attached', async () => {
    uploadImpl = async () => { throw new Error('disk full') }
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.attach(pngFile())
    })

    await waitFor(() => expect(result.current.error).toBe('disk full'))
    expect(result.current.reference).toBeNull()
    expect(result.current.previewUrl).toBeNull()
  })

  it('rejects an unsupported file before ever touching the network', async () => {
    let uploadCalled = false
    uploadImpl = async () => { uploadCalled = true; return meta }
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.attach(new File([new Uint8Array(10)], 'anim.gif', { type: 'image/gif' }))
    })

    expect(uploadCalled).toBe(false)
    expect(result.current.reference).toBeNull()
  })

  it('remove() clears local state immediately and asks the server to delete the artifact', async () => {
    fetchImpl = async () => meta
    let deletedId: string | null = null
    deleteImpl = async () => {}
    const { result } = renderHook(() => useDesignReferenceAttachment())
    await waitFor(() => expect(result.current.reference).toEqual(meta))

    deleteImpl = async () => { deletedId = meta.id }
    act(() => {
      result.current.remove()
    })

    expect(result.current.reference).toBeNull()
    await waitFor(() => expect(deletedId).toBe(meta.id))
  })
})
