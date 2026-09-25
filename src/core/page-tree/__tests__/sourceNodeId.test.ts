/**
 * sourceNodeId — grammar round-trips, plus `store-10` R2's two new helpers:
 * `callSitePosition` / `matchesCallSitePosition`. These exist so a refused
 * gesture's retry can re-find the node that replaces a `shared-component` id
 * after a detach/extract reload re-mints everything derived from the
 * component's OWN definition file — the call site's own position is the one
 * thing that survives both codemods untouched. See `sourceNodeId.ts`'s doc.
 */
import { describe, expect, it } from 'bun:test'
import {
  INLINE_ID_SEPARATOR,
  callSitePosition,
  decodeSourceNodeId,
} from '../sourceNodeId'

describe('callSitePosition', () => {
  it('returns a plain id unchanged', () => {
    expect(callSitePosition('src/screens/Home.jsx:65:16')).toBe('src/screens/Home.jsx:65:16')
  })

  it('returns the HEAD of a composite (shared-component) id, not the tail decodeSourceNodeId reads', () => {
    const nodeId = `pages/Home.jsx:77:19${INLINE_ID_SEPARATOR}components/Icon.jsx:3:6`
    expect(callSitePosition(nodeId)).toBe('pages/Home.jsx:77:19')
    // Sanity: the tail decodeSourceNodeId resolves is the DIFFERENT, definition-file half.
    expect(decodeSourceNodeId(nodeId)).toEqual({ rel: 'components/Icon.jsx', line: 3, col: 6 })
  })

  it('returns the head even with a `.map` iteration suffix on the call site', () => {
    const nodeId = `pages/List.jsx:10:4#2${INLINE_ID_SEPARATOR}components/Row.jsx:1:1`
    expect(callSitePosition(nodeId)).toBe('pages/List.jsx:10:4#2')
  })
})

