/**
 * P5-A — what is on the OS clipboard, and what ⌘V means
 * (`canvasClipboardData.ts`). Pure: the decision table, the Studio marker, the
 * SVG sniff and the two snapshot readers (a `paste` event's `DataTransfer`,
 * and the async Clipboard API's items for the Safari fallback).
 */
import { describe, expect, it } from 'bun:test'
import {
  STUDIO_NODES_MIME,
  UNREADABLE_CLIPBOARD,
  decideCanvasPaste,
  looksLikeSvgDocument,
  readMarkerDigits,
  readMarkerHtml,
  snapshotFromClipboardItems,
  snapshotFromDataTransfer,
  studioMarkerHtml,
  type ClipboardSnapshot,
} from '@site/canvas/canvasClipboardData'

const COPIED_AT = 1_727_000_000_000
const png = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' })
const SVG = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'

function snapshot(overrides: Partial<ClipboardSnapshot> = {}): ClipboardSnapshot {
  return { readable: true, marker: null, images: [], svg: null, ...overrides }
}

describe('decideCanvasPaste — the decision table (IMG-4, SVG-5 §4.5)', () => {
  it('a marker matching the entry pastes the copied layers, even over an image beside it', () => {
    expect(decideCanvasPaste(snapshot({ marker: COPIED_AT, images: [png] }), COPIED_AT)).toEqual({ kind: 'nodes' })
  })

  it('with NO marker, an image on the clipboard wins over layers copied earlier — it is newer than that copy', () => {
    expect(decideCanvasPaste(snapshot({ images: [png] }), COPIED_AT)).toEqual({ kind: 'images', files: [png] })
  })

  it('an SVG document beats a raster image offered beside it', () => {
    const svg = { kind: 'text' as const, markup: SVG }
    expect(decideCanvasPaste(snapshot({ svg, images: [png] }), COPIED_AT)).toEqual({ kind: 'svg', source: svg })
  })

  it('a marker from another tab is not this editor’s layers, and is not pasted as them', () => {
    expect(decideCanvasPaste(snapshot({ marker: COPIED_AT + 5 }), COPIED_AT)).toEqual({ kind: 'none', reason: 'foreign-marker' })
  })

  it('a clipboard with nothing Studio can paste (plain text) falls back to the copied layers — the old ⌘V', () => {
    expect(decideCanvasPaste(snapshot(), COPIED_AT)).toEqual({ kind: 'nodes' })
  })

  it('an unreadable clipboard falls back to the copied layers, and says so only when there are none', () => {
    expect(decideCanvasPaste(UNREADABLE_CLIPBOARD, COPIED_AT)).toEqual({ kind: 'nodes' })
    expect(decideCanvasPaste(UNREADABLE_CLIPBOARD, null)).toEqual({ kind: 'none', reason: 'unreadable' })
    expect(decideCanvasPaste(snapshot(), null)).toEqual({ kind: 'none', reason: 'empty' })
  })
})

describe('the Studio marker', () => {
  it('round-trips through both of its forms', () => {
    expect(readMarkerHtml(studioMarkerHtml(COPIED_AT))).toBe(COPIED_AT)
    expect(readMarkerDigits(String(COPIED_AT))).toBe(COPIED_AT)
  })

  it('survives the <meta charset> a browser prepends to written HTML', () => {
    expect(readMarkerHtml(`<meta charset='utf-8'>${studioMarkerHtml(COPIED_AT)}`)).toBe(COPIED_AT)
  })

  it('reads nothing else as a marker', () => {
    expect(readMarkerDigits('12ab')).toBeNull()
    expect(readMarkerDigits('')).toBeNull()
    expect(readMarkerDigits(null)).toBeNull()
    expect(readMarkerHtml('<span data-studio-nodes="x1">')).toBeNull()
    expect(readMarkerHtml('<p>copied from a web page</p>')).toBeNull()
    // Only the head is scanned: a marker buried in a large foreign document is not Studio's.
    expect(readMarkerHtml(`${'<p>x</p>'.repeat(200)}${studioMarkerHtml(COPIED_AT)}`)).toBeNull()
  })
})

describe('looksLikeSvgDocument', () => {
  it('accepts an svg root, with an optional prolog, DOCTYPE, comments and byte-order mark', () => {
    expect(looksLikeSvgDocument(SVG)).toBe(true)
    expect(looksLikeSvgDocument(`  \n<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Illustrator -->\n${SVG}\n`)).toBe(true)
    expect(
      looksLikeSvgDocument(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${SVG}`),
    ).toBe(true)
    expect(looksLikeSvgDocument(`${String.fromCharCode(0xfeff)}${SVG}`)).toBe(true)
    expect(looksLikeSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true)
  })

  it('rejects text that merely contains an svg', () => {
    expect(looksLikeSvgDocument(`<div>${SVG}</div>`)).toBe(false)
    expect(looksLikeSvgDocument(`Paste this: ${SVG}`)).toBe(false)
    expect(looksLikeSvgDocument(`${SVG} and some prose after it`)).toBe(false)
    expect(looksLikeSvgDocument('<svgfoo></svgfoo>')).toBe(false)
    expect(looksLikeSvgDocument('just words')).toBe(false)
  })

  it('costs the same for a multi-megabyte paste — it reads only the head and the tail', () => {
    const huge = `<svg>${'<path d="M0 0"/>'.repeat(200_000)}</svg>`
    const hostile = `<!--${'<!--'.repeat(500_000)}`
    const started = performance.now()
    expect(looksLikeSvgDocument(huge)).toBe(true)
    expect(looksLikeSvgDocument(hostile)).toBe(false)
    expect(performance.now() - started).toBeLessThan(250)
  })
})

/** A `DataTransfer` stand-in: the three members the reader touches. */
function dataTransfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  return { getData: (type: string) => data[type] ?? '', files } as unknown as DataTransfer
}

describe('snapshotFromDataTransfer — a paste event', () => {
  it('reads the custom-type marker, and the HTML one when only that survived', () => {
    expect(snapshotFromDataTransfer(dataTransfer({ [STUDIO_NODES_MIME]: String(COPIED_AT) })).marker).toBe(COPIED_AT)
    expect(snapshotFromDataTransfer(dataTransfer({ 'text/html': studioMarkerHtml(COPIED_AT) })).marker).toBe(COPIED_AT)
  })

  it('separates raster images from an SVG file, and prefers SVG text', () => {
    const svgFile = new File([SVG], 'icon.svg', { type: 'image/svg+xml' })
    const fromFiles = snapshotFromDataTransfer(dataTransfer({}, [png, svgFile]))
    expect(fromFiles.images).toEqual([png])
    expect(fromFiles.svg).toEqual({ kind: 'file', file: svgFile })
    const fromText = snapshotFromDataTransfer(dataTransfer({ 'text/plain': SVG }, [svgFile]))
    expect(fromText.svg).toEqual({ kind: 'text', markup: SVG })
  })

  it('treats ordinary text as nothing to paste, and a missing DataTransfer as unreadable', () => {
    expect(snapshotFromDataTransfer(dataTransfer({ 'text/plain': 'hello' }))).toEqual(snapshot())
    expect(snapshotFromDataTransfer(null)).toBe(UNREADABLE_CLIPBOARD)
  })
})

describe('snapshotFromClipboardItems — the async API fallback', () => {
  const item = (entries: Record<string, Blob>) => ({
    types: Object.keys(entries),
    getType: async (type: string) => entries[type]!,
  })

  it('reads the HTML marker, an SVG in text/plain, and names raster images by their type', async () => {
    const result = await snapshotFromClipboardItems([
      item({ 'text/html': new Blob([studioMarkerHtml(COPIED_AT)]) }),
      item({ 'text/plain': new Blob([SVG]) }),
      item({ 'image/jpeg': new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }) }),
    ])
    expect(result.marker).toBe(COPIED_AT)
    expect(result.svg).toEqual({ kind: 'text', markup: SVG })
    expect(result.images.map((file) => [file.name, file.type])).toEqual([['pasted-image.jpg', 'image/jpeg']])
  })
})
