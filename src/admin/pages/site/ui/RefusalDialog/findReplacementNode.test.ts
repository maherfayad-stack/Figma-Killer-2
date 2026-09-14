import { describe, expect, it } from 'bun:test'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
import { findReplacementNodeId } from './findReplacementNode'

const CALL_SITE = 'src/pages/Home.tsx:5:1'

describe('findReplacementNodeId', () => {
  it('finds a plain-id node at the call site (detach)', () => {
    const page = makePage({
      nodes: {
        root: makeNode({ id: 'root', children: [CALL_SITE] }),
        [CALL_SITE]: makeNode({ id: CALL_SITE }),
      },
    })
    const site = makeSite({ pages: [page] })

    expect(findReplacementNodeId(site, CALL_SITE)).toBe(CALL_SITE)
  })

  it('finds a re-inlined composite id at the same call site (extract into a new component)', () => {
    const newId = `${CALL_SITE}~src/components/Icon2.tsx:3:6`
    const page = makePage({
      nodes: {
        root: makeNode({ id: 'root', children: [newId] }),
        [newId]: makeNode({ id: newId }),
      },
    })
    const site = makeSite({ pages: [page] })

    expect(findReplacementNodeId(site, CALL_SITE)).toBe(newId)
  })

  it('also scans Visual Component trees, not just pages', () => {
    const site = makeSite({
      pages: [makePage()],
      visualComponents: [
        {
          id: 'vc-1',
          name: 'Card',
          params: [],
          classIds: [],
          createdAt: 0,
          tree: {
            rootNodeId: 'vc-root',
            nodes: {
              'vc-root': makeNode({ id: 'vc-root', children: [CALL_SITE] }),
              [CALL_SITE]: makeNode({ id: CALL_SITE }),
            },
          },
        },
      ],
    })

    expect(findReplacementNodeId(site, CALL_SITE)).toBe(CALL_SITE)
  })

  it('returns undefined when nothing occupies the call site', () => {
    const site = makeSite({ pages: [makePage()] })
    expect(findReplacementNodeId(site, CALL_SITE)).toBeUndefined()
  })

  it('does not false-positive on a call site that is merely a string prefix of another', () => {
    const otherId = `${CALL_SITE}0:extra` // shares the CALL_SITE string as a naive prefix, not a real match
    const page = makePage({
      nodes: {
        root: makeNode({ id: 'root', children: [otherId] }),
        [otherId]: makeNode({ id: otherId }),
      },
    })
    const site = makeSite({ pages: [page] })

    expect(findReplacementNodeId(site, CALL_SITE)).toBeUndefined()
  })
})
