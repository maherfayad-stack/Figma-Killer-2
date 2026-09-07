/**
 * figmaUrl — the shared Figma-link parser. Four of these cases moved here
 * verbatim from `server/handlers/__tests__/figmaCodeConnect.test.ts` when the
 * parser was extracted out of that module; the rest cover the shapes the
 * NEW callers (the chat-message scan in `liveDigest.ts`,
 * `studio_import_figma_frame`'s `url` argument) actually meet — a link pasted
 * mid-sentence, an old `/file/` link, a `%3A`-separated node id.
 */
import { describe, expect, it } from 'bun:test'
import { findFigmaUrlInText, parseFigmaUrl } from './figmaUrl'

describe('parseFigmaUrl', () => {
  it('parses the file key and normalizes a real node-id to colon form', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/8nasqgUrdKsT8JgQRBHwPB/Styles?node-id=53958-5861')).toEqual({
      fileKey: '8nasqgUrdKsT8JgQRBHwPB',
      nodeId: '53958:5861',
      nodeIdPlaceholder: false,
    })
  })

  it('accepts a percent-encoded colon separator as the same node id', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/ABC123/Screens?node-id=12%3A34').nodeId).toBe('12:34')
    expect(parseFigmaUrl('https://www.figma.com/design/ABC123/Screens?node-id=12%3A34').nodeIdPlaceholder).toBe(false)
  })

  it('accepts the pre-2023 /file/ spelling and prototype/board links', () => {
    expect(parseFigmaUrl('https://www.figma.com/file/KEY1/Old?node-id=1-2').fileKey).toBe('KEY1')
    expect(parseFigmaUrl('https://www.figma.com/proto/KEY2/Proto?node-id=1-2').fileKey).toBe('KEY2')
    expect(parseFigmaUrl('https://www.figma.com/board/KEY3/Jam').fileKey).toBe('KEY3')
  })

  it('reads node-id regardless of its position among the query params, and stops at a fragment', () => {
    expect(parseFigmaUrl('https://figma.com/design/K/N?t=abc&node-id=7-8&mode=design').nodeId).toBe('7:8')
    expect(parseFigmaUrl('https://figma.com/design/K/N?node-id=7-8#anchor').nodeId).toBe('7:8')
  })

  it('flags a REPLACE-ME node-id as a placeholder, not a resolvable reference', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/design/ABC123/Styles?node-id=REPLACE-ME')
    expect(parsed.fileKey).toBe('ABC123')
    expect(parsed.nodeId).toBe('REPLACE-ME')
    expect(parsed.nodeIdPlaceholder).toBe(true)
  })

  it('degrades to undefined fields for a URL with no node-id param at all', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/design/ABC123/Styles')
    expect(parsed.fileKey).toBe('ABC123')
    expect(parsed.nodeId).toBeUndefined()
    expect(parsed.nodeIdPlaceholder).toBe(true)
  })

  it('never throws on a URL matching nothing at all', () => {
    expect(parseFigmaUrl('not a url')).toEqual({ fileKey: undefined, nodeId: undefined, nodeIdPlaceholder: true })
  })

  it('never throws on a malformed percent-escape — it keeps the literal text', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/design/ABC123/S?node-id=%E0%A4%A')
    expect(parsed.fileKey).toBe('ABC123')
    expect(parsed.nodeIdPlaceholder).toBe(true)
  })
})

describe('findFigmaUrlInText', () => {
  it('finds a link pasted mid-sentence and strips the sentence punctuation off it', () => {
    const found = findFigmaUrlInText('Build https://www.figma.com/design/KEY/Screens?node-id=53958-5861. Thanks!')
    expect(found?.url).toBe('https://www.figma.com/design/KEY/Screens?node-id=53958-5861')
    expect(found?.fileKey).toBe('KEY')
    expect(found?.nodeId).toBe('53958:5861')
  })

  it('unwraps a link inside markdown parentheses', () => {
    const found = findFigmaUrlInText('see [the design](https://figma.com/design/KEY/S?node-id=1-2)')
    expect(found?.url).toBe('https://figma.com/design/KEY/S?node-id=1-2')
    expect(found?.nodeId).toBe('1:2')
  })

  it('returns the FIRST url when a message names several', () => {
    expect(findFigmaUrlInText('a https://figma.com/design/K1/A b https://figma.com/design/K2/B')?.fileKey).toBe('K1')
  })

  it('returns null for a message with no figma link', () => {
    expect(findFigmaUrlInText('make the hero bigger')).toBeNull()
    expect(findFigmaUrlInText('https://example.com/figma.com/design/K')).toBeNull()
  })

  it('still reports a figma link whose node-id is missing — the link is the signal, the node id is a bonus', () => {
    const found = findFigmaUrlInText('https://www.figma.com/design/KEY/Screens')
    expect(found?.fileKey).toBe('KEY')
    expect(found?.nodeId).toBeUndefined()
    expect(found?.nodeIdPlaceholder).toBe(true)
  })
})
