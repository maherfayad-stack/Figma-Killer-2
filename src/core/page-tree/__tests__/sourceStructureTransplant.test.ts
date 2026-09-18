/**
 * D2 G3 — `previewStructuralTransplant`'s rule: may this element leave the page
 * it is written in and land in a container on another one?
 *
 * The refusals are the reason this file exists, and they divide into two
 * groups that must not drift: the ones this rule shares with every other
 * structural gesture (a `.map` row, an inlined component, route chrome, a
 * parser lock), asserted here so a change that loosens one of them on the
 * cross-frame path alone is caught; and the two this rule owns — "one at a
 * time" and "these two frames are the same file".
 */
import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '../index'
import { previewStructuralTransplant, reindexNodeParents } from '../index'

function node(id: string, children: string[] = [], lockReason?: string): PageNode {
  return {
    id,
    moduleId: 'base.container',
    props: {},
    breakpointOverrides: {},
    children,
    locked: false,
    ...(lockReason ? { lockReason } : {}),
  }
}

function page(id: string, nodes: Record<string, PageNode>, rootNodeId: string): Page {
  reindexNodeParents(nodes)
  return { id, slug: id, title: id, rootNodeId, nodes }
}

const HOME_ROOT = 'home:body'
const HOME_MAIN = 'pages/Home.tsx:4:5'
const HOME_A = 'pages/Home.tsx:6:7'
const HOME_ROW = 'pages/Home.tsx:8:7#2'
const HOME_INLINED = 'pages/Home.tsx:6:7~ui/Icon.tsx:2:4'

const ABOUT_ROOT = 'about:body'
const ABOUT_MAIN = 'pages/About.tsx:4:5'
const ABOUT_H1 = 'pages/About.tsx:5:7'

/** `home:body → <main> → [A, a .map row, an inlined instance]`. */
function homePage(): Page {
  return page(
    'home',
    {
      [HOME_ROOT]: node(HOME_ROOT, [HOME_MAIN]),
      [HOME_MAIN]: node(HOME_MAIN, [HOME_A, HOME_ROW, HOME_INLINED]),
      [HOME_A]: node(HOME_A),
      [HOME_ROW]: node(HOME_ROW),
      [HOME_INLINED]: node(HOME_INLINED),
    },
    HOME_ROOT,
  )
}

/** `about:body → <main> → [<h1>]`. */
function aboutPage(): Page {
  return page(
    'about',
    {
      [ABOUT_ROOT]: node(ABOUT_ROOT, [ABOUT_MAIN]),
      [ABOUT_MAIN]: node(ABOUT_MAIN, [ABOUT_H1]),
      [ABOUT_H1]: node(ABOUT_H1),
    },
    ABOUT_ROOT,
  )
}

describe('previewStructuralTransplant — what it commits', () => {
  it('commits the container and the neighbour the drop landed beside', () => {
    const result = previewStructuralTransplant({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })

    expect(result).toEqual({
      ok: true,
      commit: {
        nodeId: HOME_A,
        destinationParentNodeId: ABOUT_MAIN,
        anchorNodeId: ABOUT_H1,
        position: 'before',
        copy: false,
      },
    })
  })

  it('appends when the drop landed past the container last child', () => {
    const result = previewStructuralTransplant({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 5,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commit.anchorNodeId).toBeNull()
    expect(result.commit.position).toBe('after')
  })

  it('resolves the synthetic page root to the page own root element, and drops the index with it', () => {
    const result = previewStructuralTransplant({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: aboutPage(),
      newParentId: ABOUT_ROOT,
      newIndex: 0,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commit.destinationParentNodeId).toBe(ABOUT_MAIN)
    // The index named a position in the ROOT's child list, not `<main>`'s, so
    // it is dropped rather than applied to the wrong list.
    expect(result.commit.anchorNodeId).toBeNull()
  })

  it('carries the copy flag through untouched — Alt across frames is the same rule', () => {
    const result = previewStructuralTransplant({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
      copy: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commit.copy).toBe(true)
  })
})

describe('previewStructuralTransplant — refusals', () => {
  function refuse(input: Parameters<typeof previewStructuralTransplant>[0]) {
    const result = previewStructuralTransplant(input)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    return result
  }

  it('REFUSES more than one element, and says to drag them one by one', () => {
    const result = refuse({
      originTree: homePage(),
      nodeIds: [HOME_A, HOME_ROW],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('multi-select')
    expect(result.refusal.message).toContain('one by one')
  })

  it('REFUSES a `.map` row with the vocabulary every other gesture uses for it', () => {
    const result = refuse({
      originTree: homePage(),
      nodeIds: [HOME_ROW],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('list-row')
  })

  it('REFUSES an inlined component instance', () => {
    const result = refuse({
      originTree: homePage(),
      nodeIds: [HOME_INLINED],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('shared-component')
  })

  it('REFUSES a parser-locked element', () => {
    const origin = homePage()
    origin.nodes[HOME_A] = node(HOME_A, [], 'spread-props')
    const result = refuse({
      originTree: origin,
      nodeIds: [HOME_A],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('code-placed')
  })

  it('REFUSES a container that is itself a `.map` row, and says which end is wrong', () => {
    const destination = aboutPage()
    const rowContainer = 'pages/About.tsx:9:7#1'
    destination.nodes[rowContainer] = node(rowContainer)
    destination.nodes[ABOUT_MAIN]!.children.push(rowContainer)
    reindexNodeParents(destination.nodes)

    const result = refuse({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: destination,
      newParentId: rowContainer,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('list-row')
    expect(result.refusal.message).toContain('The container this would land in')
  })

  it('REFUSES a node minted on the canvas — there is no markup to move', () => {
    const origin = homePage()
    const minted = 'nanoid-minted-node'
    origin.nodes[minted] = node(minted)
    origin.nodes[HOME_MAIN]!.children.push(minted)
    reindexNodeParents(origin.nodes)

    const result = refuse({
      originTree: origin,
      nodeIds: [minted],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('insert')
    expect(result.refusal.message).toContain('exists only on the canvas')
  })

  it('REFUSES two frames of the SAME file — that is an ordinary move', () => {
    const result = refuse({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: homePage(),
      newParentId: HOME_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('reparent')
    expect(result.refusal.message).toContain('two views of the same file')
  })

  it('REFUSES a destination page with no single root element to point at', () => {
    const destination = page(
      'about',
      { [ABOUT_ROOT]: node(ABOUT_ROOT, []) },
      ABOUT_ROOT,
    )
    const result = refuse({
      originTree: homePage(),
      nodeIds: [HOME_A],
      destinationTree: destination,
      newParentId: ABOUT_ROOT,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('insert')
  })

  it('REFUSES a stale drag source rather than inventing a commit for it', () => {
    const result = refuse({
      originTree: homePage(),
      nodeIds: ['pages/Home.tsx:99:99'],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(result.refusal.reason).toBe('reparent')
    expect(result.refusal.message).toContain('no longer on the board')
  })
})

/**
 * A cross-frame COPY is not a cross-frame move with a flag. `copy: true` writes
 * one new element into the DESTINATION page's own file and leaves the origin's
 * bytes untouched (`transplantJsxElement`), so the two refusals whose whole
 * argument is "the change would apply to every place this is used" stop being
 * true of it - while the two that are about the markup ITSELF do not.
 *
 * These four tests are the contract the "Duplicate into frame instead" remedy
 * rests on: it is offered exactly when re-asking this function with
 * `copy: true` comes back `ok`, so a change here changes the button, and a
 * button that led back to the same refusal would fail these.
 */
describe('previewStructuralTransplant - what a COPY escapes, and what it does not', () => {
  it('ALLOWS copying an inlined component instance - the component keeps its own markup', () => {
    const result = previewStructuralTransplant({
      originTree: homePage(),
      nodeIds: [HOME_INLINED],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
      copy: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.commit.copy).toBe(true)
    expect(result.commit.nodeId).toBe(HOME_INLINED)
  })

  it('ALLOWS copying markup out of a layout file - no other page is touched', () => {
    const origin = homePage()
    const chrome = 'app/layout.tsx:7:5'
    origin.nodes[chrome] = node(chrome)
    origin.nodes[HOME_MAIN]!.children.push(chrome)
    reindexNodeParents(origin.nodes)

    expect(
      previewStructuralTransplant({
        originTree: origin,
        nodeIds: [chrome],
        destinationTree: aboutPage(),
        newParentId: ABOUT_MAIN,
        newIndex: 0,
        copy: true,
      }).ok,
    ).toBe(true)

    // The MOVE still refuses: cutting it out of the layout changes every page
    // rendered below it.
    const moved = previewStructuralTransplant({
      originTree: origin,
      nodeIds: [chrome],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
    })
    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.refusal.reason).toBe('route-chrome')
  })

  it('still REFUSES copying a `.map` row - there is no source range to read', () => {
    const result = previewStructuralTransplant({
      originTree: homePage(),
      nodeIds: [HOME_ROW],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
      copy: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('list-row')
  })

  it('still REFUSES copying a parser-locked element - the code decides its shape', () => {
    const origin = homePage()
    origin.nodes[HOME_A] = node(HOME_A, [], 'spread props')
    const result = previewStructuralTransplant({
      originTree: origin,
      nodeIds: [HOME_A],
      destinationTree: aboutPage(),
      newParentId: ABOUT_MAIN,
      newIndex: 0,
      copy: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toBe('code-placed')
  })
})
