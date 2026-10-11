/**
 * P5-B3 (IMG-5, OD-13) — what a drop on the board carries. The rule under
 * test: a LINK becomes a server fetch only when the drag itself says "image";
 * anything else is refused here, with a sentence, and costs no request.
 *
 * `DataTransfer` does not exist under happy-dom, so the transfer is the plain
 * object the intake reads: `files`, `types` and `getData`.
 */
import { describe, expect, it } from 'bun:test'
import { MAX_DATA_URL_IMAGE_BYTES, fileFromImageDataUrl, readDroppedImageIntake } from '@site/canvas/canvasDropIntake'

function transfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  const types = [...(files.length > 0 ? ['Files'] : []), ...Object.keys(data)]
  return { files, types, getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer
}

const png = (name = 'photo.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

describe('readDroppedImageIntake', () => {
  it('leaves a drag with neither files nor a link alone', () => {
    expect(readDroppedImageIntake(transfer({ 'text/plain': 'hello' }))).toBeNull()
    expect(readDroppedImageIntake(null)).toBeNull()
  })

  it('prefers the FILE when a browser hands over both a file and a link', () => {
    const file = png()
    const intake = readDroppedImageIntake(transfer({ 'text/uri-list': 'https://example.com/photo.png' }, [file]))
    expect(intake).toEqual({ kind: 'files', files: [file] })
  })

  it('an image dragged out of a tab: the dragged <img src> is the URL the server fetches', () => {
    const intake = readDroppedImageIntake(
      transfer({
        'text/uri-list': 'https://example.com/article',
        'text/html': '<meta charset="utf-8"><img src="https://cdn.example.com/photos/cat" alt="cat">',
      }),
    )
    expect(intake).toEqual({ kind: 'link', source: { kind: 'url', url: 'https://cdn.example.com/photos/cat' } })
  })

  it('a bare link whose path is an image is fetched', () => {
    const intake = readDroppedImageIntake(transfer({ 'text/uri-list': '# comment\nhttps://example.com/a/b/hero.webp' }))
    expect(intake).toEqual({ kind: 'link', source: { kind: 'url', url: 'https://example.com/a/b/hero.webp' } })
  })

  it('a link to a PAGE is refused without a request', () => {
    const intake = readDroppedImageIntake(transfer({ 'text/uri-list': 'https://example.com/blog/post' }))
    expect(intake?.kind).toBe('refused')
  })

  for (const url of ['javascript:alert(1)', 'file:///etc/passwd.png', 'ftp://example.com/a.png', 'blob:https://evil.test/x']) {
    it(`refuses ${url.slice(0, url.indexOf(':') + 1)} and never makes it a fetch`, () => {
      expect(readDroppedImageIntake(transfer({ 'text/uri-list': url }))?.kind).toBe('refused')
    })
  }

  it('an <img> whose src is a javascript: URL is refused too', () => {
    const intake = readDroppedImageIntake(
      transfer({ 'text/uri-list': 'https://example.com/', 'text/html': '<img src="javascript:alert(1)">' }),
    )
    expect(intake?.kind).toBe('refused')
  })

  it('a data:image link is decoded in the browser into a file — the server never parses data:', () => {
    const intake = readDroppedImageIntake(transfer({ 'text/uri-list': 'data:image/png;base64,iVBORw0KGgo=' }))
    if (intake?.kind !== 'link' || intake.source.kind !== 'file') throw new Error('expected a decoded file')
    expect(intake.source.file.type).toBe('image/png')
    expect(intake.source.file.name).toBe('image.png')
    expect(intake.source.file.size).toBe(8)
  })
})

describe('fileFromImageDataUrl', () => {
  it('refuses data that is not an image', () => {
    expect(fileFromImageDataUrl('data:text/html;base64,PHNjcmlwdD4=').kind).toBe('refused')
  })

  it('refuses a payload over the drop cap before decoding it', () => {
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_DATA_URL_IMAGE_BYTES * 4) / 3) + 8)}`
    expect(fileFromImageDataUrl(huge).kind).toBe('refused')
  })

  it('decodes a percent-encoded SVG', () => {
    const intake = fileFromImageDataUrl('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E')
    if (intake.kind !== 'link' || intake.source.kind !== 'file') throw new Error('expected a decoded file')
    expect(intake.source.file.name).toBe('image.svg')
  })

  it('refuses malformed base64', () => {
    expect(fileFromImageDataUrl('data:image/png;base64,!!!not-base64!!!').kind).toBe('refused')
  })
})
