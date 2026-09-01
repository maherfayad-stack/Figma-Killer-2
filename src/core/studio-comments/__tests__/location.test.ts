/**
 * What an agent is told about where a comment is.
 *
 * Every assertion here stands in for a question the agent would otherwise
 * answer by guessing: which page file, which element, how far down the frame,
 * and whether the element it is about to edit is still the one that was
 * commented on.
 */
import { describe, it, expect } from 'bun:test'
import type { BaseNode, NodeTree } from '@core/page-tree'
import {
  buildCommentLocation,
  describeCommentLocation,
  nodeTrail,
  sourceFileOfNodeId,
} from '../location'
import type { CommentAnchor, CommentThread } from '../types'

function node(
  id: string,
  moduleId: string,
  children: string[] = [],
  props: Record<string, unknown> = {},
  label?: string,
): BaseNode {
  return { id, moduleId, props, breakpointOverrides: {}, children, ...(label ? { label } : {}) }
}

/**
 * root
 *  └─ screen                 (base.container, labelled "Screen")
 *      └─ sheet              (alm.BottomSheet)
 *          └─ skip           (base.text, "Skip")
 */
function tree(): NodeTree {
  return {
    rootNodeId: 'pages/Home.tsx:1:1',
    nodes: {
      'pages/Home.tsx:1:1': node('pages/Home.tsx:1:1', 'base.body', ['pages/Home.tsx:3:3']),
      'pages/Home.tsx:3:3': node(
        'pages/Home.tsx:3:3',
        'base.container',
        ['pages/Home.tsx:5:6'],
        {},
        'Screen',
      ),
      'pages/Home.tsx:5:6': node('pages/Home.tsx:5:6', 'alm.BottomSheet', ['pages/Home.tsx:7:9']),
      'pages/Home.tsx:7:9': node('pages/Home.tsx:7:9', 'base.text', [], { text: 'Skip' }),
    },
  }
}

const anchor = (over: Partial<CommentAnchor> = {}): CommentAnchor => ({
  frameId: 'frame-1',
  pageId: 'home',
  dx: 90,
  dy: 264,
  node: {
    nodeId: 'pages/Home.tsx:7:9',
    indexPath: [0, 0, 0],
    moduleId: 'base.text',
    textSnippet: 'Skip',
  },
  ...over,
})

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: 't1',
  seq: 3,
  boardId: 'board-1',
  anchor: anchor(),
  resolved: false,
  createdAt: '2026-09-01T09:00:00.000Z',
  comments: [
    {
      id: 'c1',
      author: { userId: 'u1', displayName: 'Maher', kind: 'user' },
      body: 'Move this up',
      createdAt: '2026-09-01T09:00:00.000Z',
      editedAt: null,
    },
  ],
  ...over,
})

const sources = {
  boardName: 'Board 1',
  pageTitle: 'Home',
  tree: tree(),
  frameWidth: 360,
  frameHeight: 800,
}

describe('sourceFileOfNodeId', () => {
  it('takes the file part, not the first colon-delimited segment', () => {
    expect(sourceFileOfNodeId('pages/Home.tsx:5:6')).toBe('pages/Home.tsx')
    // A path may legitimately contain a colon; only the trailing pair is
    // structural, which is why the pattern is anchored at the end.
    expect(sourceFileOfNodeId('src/a:b/Home.tsx:5:6')).toBe('src/a:b/Home.tsx')
  })

  it('returns null for something that is not a positional id', () => {
    expect(sourceFileOfNodeId('nanoid-style-id')).toBeNull()
  })
})

describe('nodeTrail', () => {
  it('names each ancestor from the page root down, root excluded', () => {
    expect(nodeTrail(tree(), 'pages/Home.tsx:7:9')).toEqual([
      'Screen',
      'alm.BottomSheet',
      'base.text “Skip”',
    ])
  })

  it('is empty for a node that is not in the tree', () => {
    expect(nodeTrail(tree(), 'pages/Home.tsx:99:9')).toEqual([])
  })
})

describe('buildCommentLocation', () => {
  it('resolves every stored id into something a person could act on', () => {
    const loc = buildCommentLocation(thread(), sources)

    expect(loc.boardName).toBe('Board 1')
    expect(loc.pageTitle).toBe('Home')
    expect(loc.pageFile).toBe('pages/Home.tsx')
    expect(loc.frameId).toBe('frame-1')
    expect(loc.confidence).toBe('exact')
    expect(loc.element).toEqual({
      nodeId: 'pages/Home.tsx:7:9',
      moduleId: 'base.text',
      text: 'Skip',
      trail: ['Screen', 'alm.BottomSheet', 'base.text “Skip”'],
    })
  })

  it('gives the pin position in pixels and as a share of the frame', () => {
    // Pixels alone are unreadable without the frame's size, which the agent
    // does not otherwise have.
    const loc = buildCommentLocation(thread(), sources)
    expect(loc.dx).toBe(90)
    expect(loc.dy).toBe(264)
    expect(loc.xPercent).toBe(25)
    expect(loc.yPercent).toBe(33)
  })

  it('omits the percentages rather than inventing a frame size', () => {
    const loc = buildCommentLocation(thread(), { ...sources, frameWidth: null, frameHeight: 0 })
    expect(loc.xPercent).toBeNull()
    expect(loc.yPercent).toBeNull()
  })

  it('falls back to the stored hint, with no trail, when the element is gone', () => {
    // The words survive even when the id does not — often enough to find the
    // element by hand — but the empty trail says it was not re-resolved.
    const gone = thread({
      anchor: anchor({
        node: {
          nodeId: 'pages/Home.tsx:999:9',
          indexPath: [9],
          moduleId: 'base.text',
          textSnippet: 'Long gone',
        },
      }),
    })
    const loc = buildCommentLocation(gone, sources)
    expect(loc.confidence).toBe('detached')
    expect(loc.element).toEqual({
      nodeId: 'pages/Home.tsx:999:9',
      moduleId: 'base.text',
      text: 'Long gone',
      trail: [],
    })
  })

  it('reports no element at all for a pin dropped on empty canvas', () => {
    const loose = thread({ anchor: anchor({ node: null, frameId: null, pageId: null }) })
    const loc = buildCommentLocation(loose, sources)
    expect(loc.element).toBeNull()
    expect(loc.confidence).toBe('unanchored')
  })

  it('says "unknown", not "detached", when the caller did not check', () => {
    // The distinction is the whole point of `checkAnchor`: "I did not look"
    // must never render as "the element is gone" in a briefing an agent acts on.
    const loc = buildCommentLocation(thread(), { ...sources, tree: null, checkAnchor: false })
    expect(loc.confidence).toBeNull()
    expect(loc.element?.nodeId).toBe('pages/Home.tsx:7:9')
  })
})

describe('describeCommentLocation', () => {
  it('names the surface, the point, the element and the trust in that order', () => {
    const text = describeCommentLocation(buildCommentLocation(thread(), sources))

    expect(text).toContain('### Comment #3')
    expect(text).toContain('Board: “Board 1”, frame frame-1')
    expect(text).toContain('Page: “Home” — `pages/Home.tsx`')
    expect(text).toContain('90px across, 264px down (25% across, 33% down)')
    expect(text).toContain('Path from the page root: Screen › alm.BottomSheet › base.text “Skip”')
    expect(text).toContain('anchor exact')
  })

  it('tells the agent not to edit at a detached id', () => {
    const gone = thread({
      anchor: anchor({
        node: {
          nodeId: 'pages/Home.tsx:999:9',
          indexPath: [9],
          moduleId: 'base.text',
          textSnippet: 'Long gone',
        },
      }),
    })
    const text = describeCommentLocation(buildCommentLocation(gone, sources))
    expect(text).toContain('DETACHED')
    expect(text).toContain('leave the thread open')
  })

  it('drops the anchor line entirely when the anchor was not checked', () => {
    const text = describeCommentLocation(
      buildCommentLocation(thread(), { ...sources, tree: null, checkAnchor: false }),
    )
    expect(text).not.toContain('Anchor:')
  })
})
