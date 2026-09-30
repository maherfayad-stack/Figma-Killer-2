/**
 * The image-landing clients target ONE project (IMG-1, audit 07 §A.1 bug 3),
 * and speak through ONE upload transport (P5-B IMG-8).
 *
 * `dropStudioAsset` resolved the project with `studioWriteDir()` (the
 * explicit selection, else the dir the last load actually read), while
 * `uploadStudioAsset` read only the localStorage selection. In a session with
 * no explicit selection the upload sent no `dir` at all, so the server fell
 * back to the FIRST project on disk, which is not necessarily the open one.
 *
 * Both now go through `apiUploadRequest` (XHR, for upload progress), so the
 * test drives one stub `XMLHttpRequest` and reads each route's `dir` field
 * off it. The drop route is in `IDEMPOTENT_REPLAY_PATHS`, so it must still
 * carry the replay key the server recognises a retry by.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { dropStudioAsset } from '../dropStudioAsset'
import { setStudioLoadedDir, setStudioWorkspaceDir } from '../studioWorkspaceDir'
import { uploadStudioAsset } from '../uploadStudioAsset'
import { createFakeUploadXhr } from './fakeUploadXhr'

const LOADED_DIR = '/workspace/the-open-project'

const xhr = createFakeUploadXhr((url) =>
  url.startsWith('/admin/api/studio/asset-drop')
    ? {
        status: 200,
        body: { ok: true, mode: 'public', relPath: 'public/a.png', src: '/a.png', width: null, height: null, deduped: false },
        progress: [0.5, 1],
      }
    : { status: 200, body: { ok: true, relPath: 'src/assets/a.png', src: null, width: null, height: null, deduped: false } },
)

function sentDir(route: string): FormDataEntryValue | null {
  return xhr.requests.find((request) => request.url.startsWith(route))?.body.get('dir') ?? null
}

beforeEach(() => {
  xhr.requests.length = 0
  // No explicit selection: the session is on whatever the last load read.
  setStudioWorkspaceDir(null)
  setStudioLoadedDir(LOADED_DIR)
  xhr.install()
})

afterEach(() => {
  setStudioLoadedDir(null)
  xhr.restore()
})

const file = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' })

describe('image landing clients — which project', () => {
  it('uploadStudioAsset sends the dir the last load read when nothing is explicitly selected', async () => {
    await uploadStudioAsset(file())
    expect(sentDir('/admin/api/studio/asset-upload')).toBe(LOADED_DIR)
  })

  it('uploadStudioAsset and dropStudioAsset resolve the same project', async () => {
    await uploadStudioAsset(file())
    await dropStudioAsset(file())
    expect(sentDir('/admin/api/studio/asset-upload')).toBe(sentDir('/admin/api/studio/asset-drop'))
  })

  it('an explicit selection wins for both', async () => {
    setStudioWorkspaceDir('/workspace/picked')
    await uploadStudioAsset(file())
    await dropStudioAsset(file())
    expect([sentDir('/admin/api/studio/asset-upload'), sentDir('/admin/api/studio/asset-drop')]).toEqual([
      '/workspace/picked',
      '/workspace/picked',
    ])
  })
})

describe('dropStudioAsset — one upload transport', () => {
  it('reports upload progress and still carries the replay key', async () => {
    const fractions: number[] = []
    const landed = await dropStudioAsset(file(), { onProgress: (fraction) => fractions.push(fraction) })

    expect(landed.src).toBe('/a.png')
    expect(fractions).toEqual([0.5, 1])
    const [request] = xhr.requests
    expect(request?.headers['X-Studio-Idempotency-Key']).toBeString()
  })
})
