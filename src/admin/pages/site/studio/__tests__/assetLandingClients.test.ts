/**
 * The two image-landing clients target ONE project (IMG-1, audit 07 §A.1 bug 3).
 *
 * `dropStudioAsset` resolved the project with `studioWriteDir()` (the
 * explicit selection, else the dir the last load actually read), while
 * `uploadStudioAsset` read only the localStorage selection. In a session with
 * no explicit selection the upload sent no `dir` at all, so the server fell
 * back to the FIRST project on disk, which is not necessarily the open one.
 *
 * Driven at the transport: a stub `XMLHttpRequest` for the upload client and
 * a stub `fetch` for the drop client, each capturing the `dir` form field.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { dropStudioAsset } from '../dropStudioAsset'
import { setStudioLoadedDir, setStudioWorkspaceDir } from '../studioWorkspaceDir'
import { uploadStudioAsset } from '../uploadStudioAsset'

const LOADED_DIR = '/workspace/the-open-project'

let sentDir: { upload: FormDataEntryValue | null; drop: FormDataEntryValue | null }
const savedFetch = globalThis.fetch
const savedXhr = globalThis.XMLHttpRequest

class FakeXhr {
  status = 0
  response: unknown = null
  responseType = ''
  withCredentials = false
  upload = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open() {}
  abort() {}
  send(body: FormData) {
    sentDir.upload = body.get('dir')
    this.status = 200
    this.response = { ok: true, relPath: 'src/assets/a.png', src: null, width: null, height: null, deduped: false }
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  sentDir = { upload: null, drop: null }
  // No explicit selection: the session is on whatever the last load read.
  setStudioWorkspaceDir(null)
  setStudioLoadedDir(LOADED_DIR)
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentDir.drop = (init?.body as FormData).get('dir')
    return new Response(
      JSON.stringify({ ok: true, mode: 'public', relPath: 'public/a.png', src: '/a.png', width: null, height: null, deduped: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
})

afterEach(() => {
  setStudioLoadedDir(null)
  globalThis.fetch = savedFetch
  globalThis.XMLHttpRequest = savedXhr
})

const file = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' })

describe('image landing clients — which project', () => {
  it('uploadStudioAsset sends the dir the last load read when nothing is explicitly selected', async () => {
    await uploadStudioAsset(file())
    expect(sentDir.upload).toBe(LOADED_DIR)
  })

  it('uploadStudioAsset and dropStudioAsset resolve the same project', async () => {
    await uploadStudioAsset(file())
    await dropStudioAsset(file())
    expect(sentDir.upload).toBe(sentDir.drop)
  })

  it('an explicit selection wins for both', async () => {
    setStudioWorkspaceDir('/workspace/picked')
    await uploadStudioAsset(file())
    await dropStudioAsset(file())
    expect(sentDir).toEqual({ upload: '/workspace/picked', drop: '/workspace/picked' })
  })
})
