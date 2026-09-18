/**
 * K3 — the store's half of ⌘G / ⌘⇧G: what `planSourceGroup` and
 * `planSourceUngroup` hand back, and what the user is shown when they refuse.
 *
 * The plans are the chokepoint every surface shares (the keyboard, the
 * palette, the layers-tree menu, an agent), so this is where "grouped elements
 * that were not next to each other" and "ungrouped a container that had an
 * onClick" have to be caught — once, with a sentence, before any file is
 * opened. The engine rules have their own suite
 * (`core/page-tree/__tests__/groupUngroup.test.ts`); what is asserted here is
 * the TRANSPORT: the plan's commit shape and the `EditConstraint` a refusal
 * arrives wrapped in.
 */
import { describe, expect, it } from 'bun:test'
// `struct-11` — the content-model gate reads each node's tag through
// `ModuleDefinition.sourceIntrinsic`, so the base modules have to be
// registered for these cases to be about anything.
import '@modules/base'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import { planSourceGroup, planSourceUngroup } from '@site/store/slices/site/structuralSourceEdits'

function node(id: string, children: string[] = [], props: Record<string, unknown> = {}): PageNode {
  return { id, moduleId: 'base.container', props, breakpointOverrides: {}, children, locked: false }
}

/**
 * How `parsedPageToSitePage` spells an imported element's real tag on a
 * `base.container` node: one of the picker's own values, or the `custom`
 * sentinel plus `customTag` for everything else (`<p>`, `<li>`, `<span>`).
 * Written out here rather than always using `customTag`, so these cases are
 * shaped like what the importer actually produces.
 */
function tagProps(tag: string): Record<string, unknown> {
  const builtin = ['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'ul', 'ol']
  return builtin.includes(tag) ? { tag } : { tag: 'custom', customTag: tag }
}

/**
 * `struct-11` — a parent holding two children, with the tags a studio-imported
 * tree would carry.
 */
function contextBoard(parentTag: string, childTag: string): Page {
  const nodes: Record<string, PageNode> = {
    root: node('root', [ROOT]),
    [ROOT]: node(ROOT, [A, B], tagProps(parentTag)),
    [A]: node(A, [], tagProps(childTag)),
    [B]: node(B, [], tagProps(childTag)),
  }
  reindexNodeParents(nodes)
  return { id: 'page', slug: 'index', title: 'Home', rootNodeId: 'root', nodes }
}

const ROOT = 'src/screens/Home.jsx:10:4'
const A = 'src/screens/Home.jsx:20:6'
const B = 'src/screens/Home.jsx:22:6'
const C = 'src/screens/Home.jsx:24:6'
const ROW = 'src/screens/Home.jsx:26:6#2'

function board(): Page {
  const nodes: Record<string, PageNode> = {
    root: node('root', [ROOT]),
    [ROOT]: node(ROOT, [A, B, C, ROW]),
    [A]: node(A),
    [B]: node(B),
    [C]: node(C),
    [ROW]: node(ROW),
  }
  reindexNodeParents(nodes)
  return { id: 'page', slug: 'index', title: 'Home', rootNodeId: 'root', nodes }
}

describe('planSourceGroup', () => {
  it('commits a contiguous run in source order', () => {
    const plan = planSourceGroup(board(), [B, A])
    expect(plan).toEqual({ ok: true, commit: [A, B] })
  })

  it('commits a run of one, which the writer sends as the existing single-element wrap', () => {
    expect(planSourceGroup(board(), [C])).toEqual({ ok: true, commit: [C] })
  })

  it('REFUSES a selection with a gap, as a toast-shaped constraint with the remedy in the sentence', () => {
    const plan = planSourceGroup(board(), [A, C])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('multi-select')
    expect(plan.constraint.explanation).toContain('Select siblings next to each other')
    // `multi-select` has no button — the sentence IS the remedy, so this takes
    // the toast path rather than opening `RefusalDialog`.
    expect(plan.constraint.actions).toEqual([])
    expect(plan.nodeId).toBe(A)
  })

  it('REFUSES a group inside a <ul>, with the jump action pointed at the LIST', () => {
    const plan = planSourceGroup(contextBoard('ul', 'li'), [A, B])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('content-model')
    expect(plan.constraint.explanation).toContain('<ul>')
    // The container whose content model forbids the wrapper is the thing to go
    // and look at, so the dialog's button opens IT, not a member.
    expect(plan.nodeId).toBe(ROOT)
    expect(plan.constraint.actions).toEqual([
      { label: 'Open it in code', kind: 'jump-to-source', target: { rel: 'src/screens/Home.jsx', line: 10, col: 4 } },
    ])
  })

  it('REFUSES a group of blocks inside a <p>, where no container could be valid', () => {
    const plan = planSourceGroup(contextBoard('p', 'div'), [A, B])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('content-model')
    expect(plan.constraint.explanation).toContain('<p>')
  })

  it('does NOT refuse inline elements inside a <p> — that one is written as a <span>', () => {
    // The Phase-0 defect itself: this gesture is legal, and the only thing that
    // was wrong was the tag. Over-refusing it here would be the opposite bug.
    expect(planSourceGroup(contextBoard('p', 'span'), [A, B])).toEqual({ ok: true, commit: [A, B] })
  })

  it('REFUSES a run containing a `.map` row, with the row vocabulary and its jump action', () => {
    const plan = planSourceGroup(board(), [C, ROW])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('list-row')
    expect(plan.constraint.actions.length).toBeGreaterThan(0)
  })
})

describe('planSourceUngroup', () => {
  it('commits an ordinary container', () => {
    expect(planSourceUngroup(board(), C)).toEqual({ ok: true, commit: C })
  })

  it('REFUSES a `.map` row — one piece of source renders every row', () => {
    const plan = planSourceUngroup(board(), ROW)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('list-row')
  })

  it('says nothing about a node that is no longer on the board', () => {
    expect(planSourceUngroup(board(), 'gone')).toEqual({ ok: true, commit: null })
  })
})
