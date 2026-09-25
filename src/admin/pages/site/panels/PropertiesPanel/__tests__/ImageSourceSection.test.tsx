/**
 * ImageSourceSection — the literal-`src` replace (IMG-1, audit 07 §A.1 bug 1).
 *
 * The bug: replacing the image on `<img src="/old.png">` uploaded the file
 * through `asset-upload` with no target dir, so it landed in `src/assets/`,
 * and then wrote `'/' + relPath`: `src="/src/assets/new.png"`, a URL that
 * works in `vite dev` and 404s after a production build.
 *
 * The contract now: a literal lands through `asset-drop` (the app's
 * `public/`), and the section writes the `src` the SERVER returned, verbatim.
 * Driven at the network boundary (a stub `fetch` for `apiRequest`, a stub
 * `XMLHttpRequest` for the upload client) so the test pins which ROUTE the
 * component reaches and which string it writes, not which helper it imports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeNode } from '../../../../../../__tests__/fixtures'
import { createFakeUploadXhr } from '../../../studio/__tests__/fakeUploadXhr'
import { ImageSourceSection } from '../ImageSourceSection'

const PROP = 'src'

interface SeenRequest {
  transport: 'fetch' | 'xhr'
  url: string
}

let seen: SeenRequest[] = []
const savedFetch = globalThis.fetch
const savedCreateObjectURL = URL.createObjectURL
const savedRevokeObjectURL = URL.revokeObjectURL

/** What `asset-drop` answers: the file landed in `public/`, served at `/new.png`. */
function dropBody() {
  return {
    ok: true,
    mode: 'public',
    relPath: 'public/new.png',
    src: '/new.png',
    width: 640,
    height: 480,
    deduped: false,
  }
}

/**
 * A stand-in for the one XHR upload transport (`apiUploadRequest`). Answers
 * `asset-drop` with the landing above, and anything else the way the real
 * `asset-upload` does for a bare upload: the file lands in `src/assets/`.
 */
const fakeXhr = createFakeUploadXhr((url) => {
  seen.push({ transport: 'xhr', url })
  return url.startsWith('/admin/api/studio/asset-drop')
    ? { status: 200, body: dropBody() }
    : { status: 200, body: { ok: true, relPath: 'src/assets/new.png', src: null, width: 640, height: 480, deduped: false } }
})

beforeEach(() => {
  seen = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push({ transport: 'fetch', url })
    return new Response(JSON.stringify(dropBody()), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  fakeXhr.install()
  URL.createObjectURL = () => 'blob:preview'
  URL.revokeObjectURL = () => {}
})

afterEach(() => {
  cleanup()
  globalThis.fetch = savedFetch
  fakeXhr.restore()
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
})

function dropFile(zone: HTMLElement): void {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'new.png', { type: 'image/png' })
  fireEvent.drop(zone, { dataTransfer: { files: [file] } })
}

describe('ImageSourceSection — replacing a literal src', () => {
  it('writes the src the drop route returned, never a /src/assets/ path', async () => {
    const writes: Array<[string, unknown]> = []
    const node = makeNode({ id: 'img-1', moduleId: 'base.image', props: { src: '/old.png' } })
    const { getByTestId } = render(
      <ImageSourceSection node={node} prop={PROP} value="/old.png" onChange={(key, value) => writes.push([key, value])} />,
    )

    dropFile(getByTestId(`image-source-${PROP}`))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual([PROP, '/new.png'])
    expect(String(writes[0]![1])).not.toContain('/src/assets/')
  })

  it('lands through asset-drop, not asset-upload', async () => {
    const writes: Array<[string, unknown]> = []
    const node = makeNode({ id: 'img-1', moduleId: 'base.image', props: { src: '/old.png' } })
    const { getByTestId } = render(
      <ImageSourceSection node={node} prop={PROP} value="/old.png" onChange={(key, value) => writes.push([key, value])} />,
    )

    dropFile(getByTestId(`image-source-${PROP}`))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(seen.map((request) => request.url.split('?')[0])).toEqual(['/admin/api/studio/asset-drop'])
  })
})
