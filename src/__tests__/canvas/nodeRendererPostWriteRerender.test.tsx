/**
 * PERF-6 — what a post-write re-read costs the canvas, counted in real
 * `NodeRenderer` renders and mounts.
 *
 * A probe module counts every render and every mount of every node it backs.
 * After `patchPages` applies a re-read:
 *  - a prop write re-renders the edited node and nothing else (it used to
 *    re-render every node of the frame, because every node object was new);
 *  - a move that renumbered every node below it re-renders those nodes in
 *    place and remounts none (every one of them used to remount, because
 *    `NodeRenderer` keyed each child by its `rel:line:col` id).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { registry, type AnyModuleDefinition } from '@core/module-engine'
import type { Page, PageNode } from '@core/page-tree'
import { CanvasComposedTree } from '@site/canvas/CanvasComposedTree'
import { CanvasPageContext } from '@site/canvas/CanvasContexts'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const PROBE = 'perf6-test.probe'
const renders = new Map<string, number>()
const mounts = new Map<string, number>()
const bump = (counts: Map<string, number>, name: string) => counts.set(name, (counts.get(name) ?? 0) + 1)

interface ProbeProps {
  props: { name: string; text?: string }
  nodeWrapperProps: Record<string, unknown>
  children?: React.ReactNode
}

function Probe({ props, nodeWrapperProps, children }: ProbeProps) {
  bump(renders, props.name)
  useEffect(() => {
    bump(mounts, props.name)
    // Mount-once on purpose: a second run would mean a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div {...nodeWrapperProps}>
      {props.text}
      {children}
    </div>
  )
}

beforeAll(() => {
  registry.registerOrReplace({
    id: PROBE,
    name: 'Probe',
    category: 'Test',
    version: '1.0.0',
    trusted: true,
    canHaveChildren: true,
    schema: {},
    defaults: {},
    component: Probe,
    render: () => ({ html: '<div></div>' }),
  } as unknown as AnyModuleDefinition)
})
afterAll(() => registry.unregister(PROBE))

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  resetStore()
  renders.clear()
  mounts.clear()
})
afterEach(() => {
  cleanup()
  resetStore()
})

/**
 * A page of probe groups — group `g` holds `sizeOf(g)` item probes — laid out
 * one element per source line, so ids are real `rel:line:col` addresses and
 * moving a group renumbers everything it passes.
 */
function boardPage(order: readonly number[], sizeOf: (g: number) => number, edits: Record<string, string> = {}): Page {
  const nodes: Record<string, PageNode> = {}
  const rootId = 'p.tsx:1:1'
  const rootChildren: string[] = []
  let line = 2
  for (const g of order) {
    const groupId = `p.tsx:${line++}:5`
    const itemIds: string[] = []
    for (let i = 0; i < sizeOf(g); i++) {
      const id = `p.tsx:${line++}:7`
      const name = `g${g}-i${i}`
      nodes[id] = makeNode({ id, moduleId: PROBE, props: { name, text: edits[name] ?? name } })
      itemIds.push(id)
    }
    nodes[groupId] = makeNode({ id: groupId, moduleId: PROBE, props: { name: `g${g}` }, children: itemIds })
    rootChildren.push(groupId)
  }
  nodes[rootId] = makeNode({ id: rootId, moduleId: 'base.body', children: rootChildren })
  return makePage({ id: 'home', slug: 'index', title: 'Home', rootNodeId: rootId, nodes })
}

function Frame() {
  const page = useEditorStore((s) => s.site!.pages.find((p) => p.id === 'home')!)
  return (
    <CanvasPageContext.Provider value="home">
      <CanvasComposedTree page={page} />
    </CanvasPageContext.Provider>
  )
}

const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0)
const GROUPS = [0, 1, 2, 3, 4]
/** Groups of different sizes: a move renumbers every group it passes. */
const growing = (g: number) => g + 2
/** Groups of one size: a move PERMUTES the addresses, the id set is unchanged. */
const uniform = () => 4
const probeCount = (sizeOf: (g: number) => number) => GROUPS.reduce((n, g) => n + 1 + sizeOf(g), 0)

function mountBoard(sizeOf: (g: number) => number) {
  useEditorStore.getState().loadSite(makeSite({ pages: [boardPage(GROUPS, sizeOf)] }))
  useEditorStore.getState().setActivePage('home')
  render(<Frame />)
  expect(total(mounts)).toBe(probeCount(sizeOf))
  renders.clear()
  mounts.clear()
}

/** The DOM element the probe named `name` rendered into. */
function elementOf(name: string): Element {
  const found = [...document.querySelectorAll('[data-node-id]')].find(
    (el) => el.firstChild?.nodeType === 3 ? el.firstChild.textContent === name : false,
  )
  if (found) return found
  // A group probe renders no text of its own: find it through its first item.
  const item = [...document.querySelectorAll('[data-node-id]')].find((el) => el.textContent === `${name}-i0`)
  if (!item?.parentElement) throw new Error(`no element for ${name}`)
  return item.parentElement
}

describe('NodeRenderer after a post-write re-read (PERF-6)', () => {
  it('a prop write re-renders only the edited node', () => {
    mountBoard(growing)

    act(() => {
      useEditorStore.getState().patchPages({ pages: [boardPage(GROUPS, growing, { 'g2-i3': 'edited' })] })
    })

    expect(Object.fromEntries(renders)).toEqual({ 'g2-i3': 1 })
    expect(total(mounts)).toBe(0)
  })

  it('a move that renumbers every node below it remounts none of them', () => {
    mountBoard(growing)
    const moved = elementOf('g4')

    // The last group moves to the front: every other group's lines shift by
    // its size, so every id on the page changes but the root's.
    act(() => {
      useEditorStore.getState().patchPages({ pages: [boardPage([4, 0, 1, 2, 3], growing)] })
    })

    expect(total(mounts)).toBe(0)
    expect(elementOf('g4')).toBe(moved)
    expect(moved.getAttribute('data-node-id')).toBe('p.tsx:2:5')
    // Every renumbered node re-renders once (its id changed); none twice.
    expect(renders.size).toBe(probeCount(growing))
    expect([...renders.values()].every((n) => n === 1)).toBe(true)
  })

  it('a move that permutes same-size siblings keeps each element with its content', () => {
    mountBoard(uniform)
    const moved = elementOf('g4')
    const pushed = elementOf('g3')

    act(() => {
      useEditorStore.getState().patchPages({ pages: [boardPage([4, 0, 1, 2, 3], uniform)] })
    })

    expect(total(mounts)).toBe(0)
    expect(elementOf('g4')).toBe(moved)
    expect(elementOf('g3')).toBe(pushed)
  })
})
