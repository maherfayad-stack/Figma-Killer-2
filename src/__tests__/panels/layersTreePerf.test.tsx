/**
 * Layers tree performance harness + budget gate.
 *
 * The Layers tree (`DomPanel`) renders one row per EXPANDED node. Before
 * windowing, "expanded" and "rendered" were the same thing: a deep imported
 * page with every branch open mounted N rows, each carrying its own set of
 * `useEditorStore(...)` subscriptions, so every store commit paid
 * `rows x subscriptions-per-row` selector invocations before React started
 * work.
 *
 * Three numbers, three budgets:
 *   1. rows mounted with everything expanded  — must track the WINDOW, not the tree.
 *   2. store subscriptions per row            — a source-level count in TreeNode.tsx.
 *   3. (1) x (2) = selector invocations per store commit — the number that hurts.
 *
 * Wall times are printed, never gated: a CI box's absolute milliseconds are not
 * a contract. The gated numbers are the structural ones, which are deterministic.
 *
 * Written against the PUBLIC surface only (`<DomPanel />` + the editor store)
 * so the exact same file runs on a pre-windowing checkout to produce the
 * "before" column. See STATE.md `perf-03`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { DomPanel } from '@site/panels/DomPanel/DomPanel'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'
import type { PageNode } from '@core/page-tree'

const TREE_NODE_SOURCE_PATH = join(
  import.meta.dir,
  '../../admin/pages/site/panels/DomPanel/TreeNode.tsx',
)

afterEach(cleanup)

// ── Synthetic deep board ────────────────────────────────────────────────────
// Shaped like a real imported page rather than a balanced tree: a wide body of
// sections, each section a nested spine of wrappers that fans out into rows of
// leaves. ~2,500 nodes at depth 11 is a mid-size imported marketing page, not a
// pathological fixture.
const SECTIONS = 40
const SPINE_DEPTH = 6
const FANOUT = 6
const LEAVES_PER_BRANCH = 8

function buildDeepPage() {
  const nodes: Record<string, PageNode> = {}
  const rootId = 'root'
  const sectionIds: string[] = []

  for (let s = 0; s < SECTIONS; s += 1) {
    const sectionId = `section-${s}`
    sectionIds.push(sectionId)

    // A single-child spine of wrappers — the depth an imported page actually has.
    let spineId = sectionId
    for (let d = 0; d < SPINE_DEPTH; d += 1) {
      const childId = `s${s}-d${d}`
      nodes[spineId] = makeNode({ id: spineId, moduleId: 'base.container', children: [childId] })
      spineId = childId
    }

    // …then a fan-out of branches, each holding a run of leaves.
    const branchIds: string[] = []
    for (let b = 0; b < FANOUT; b += 1) {
      const branchId = `s${s}-b${b}`
      branchIds.push(branchId)
      const leafIds: string[] = []
      for (let l = 0; l < LEAVES_PER_BRANCH; l += 1) {
        const leafId = `s${s}-b${b}-l${l}`
        leafIds.push(leafId)
        nodes[leafId] = makeNode({ id: leafId, moduleId: 'base.text', children: [] })
      }
      nodes[branchId] = makeNode({ id: branchId, moduleId: 'base.container', children: leafIds })
    }
    nodes[spineId] = makeNode({ id: spineId, moduleId: 'base.container', children: branchIds })
  }

  nodes[rootId] = makeNode({ id: rootId, moduleId: 'base.body', children: sectionIds })
  return makePage({ id: 'page-1', rootNodeId: rootId, nodes })
}

const DEEP_PAGE = buildDeepPage()
const TOTAL_NODES = Object.keys(DEEP_PAGE.nodes).length

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    focusedPanel: 'canvas',
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadDeepSite() {
  useEditorStore.setState({
    site: makeSite({ pages: [DEEP_PAGE] }),
    activePageId: 'page-1',
  } as Parameters<typeof useEditorStore.setState>[0])
}

/**
 * happy-dom lays nothing out: every element reports height 0, and a windowed
 * list that measures 0 correctly falls back to rendering everything ("if we
 * cannot measure, do not window" — see `rowWindow.ts`). Stub a real viewport on
 * the ancestor scroller + a real row height so the window math runs the same
 * code path a browser runs.
 */
const VIEWPORT_HEIGHT = 640
const ROW_HEIGHT = 28

function stubLayout(scroller: HTMLElement) {
  Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true })
  scroller.getBoundingClientRect = () =>
    ({
      top: 0, bottom: VIEWPORT_HEIGHT, left: 0, right: 400,
      width: 400, height: VIEWPORT_HEIGHT, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect

  // Every tree row reports the compact 28px height so the window math has a
  // real unit to work with.
  const proto = (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'treeitem' ? ROW_HEIGHT : 0
    },
  })
  return () => {
    if (original) Object.defineProperty(proto, 'offsetHeight', original)
    else Reflect.deleteProperty(proto, 'offsetHeight')
  }
}

/** Renders DomPanel inside a stubbed scroll container, mirroring StudioPagesTree. */
function renderInScroller() {
  const host = document.createElement('div')
  host.setAttribute('data-layers-scroller', '')
  host.style.overflowY = 'auto'
  document.body.appendChild(host)
  const restore = stubLayout(host)
  render(<DomPanel />, { container: host })
  return { host, restore }
}

function countRows(): number {
  return document.querySelectorAll('[role="treeitem"]').length
}

/** Expand every node — the worst case the panel has to survive. */
function expandAll() {
  const panel = document.querySelector('[data-testid="dom-panel-ready"]') as HTMLElement
  act(() => {
    fireEvent.keyDown(panel, { key: 'e', ctrlKey: true })
  })
}

/**
 * Store subscriptions a single row costs. Counted from source rather than at
 * runtime: zustand's bound hook closes over the store object, so patching
 * `useEditorStore.subscribe` patches a COPY and counts nothing (verified —
 * it reports 0). The source count is the honest number and it is the one
 * work item 3 is about.
 */
function countRowSubscriptions(): number {
  const source = readFileSync(TREE_NODE_SOURCE_PATH, 'utf8')
    // Comments quote the subscription they are explaining — strip them, or the
    // count goes up every time somebody documents it.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  return (source.match(/useEditorStore\(\s*\(/g) ?? []).length
}

beforeEach(resetStore)

describe('Layers tree — windowing budgets', () => {
  it('mounts a bounded number of rows with every node expanded', () => {
    loadDeepSite()
    const { restore } = renderInScroller()
    try {
      const collapsedRows = countRows()
      const t0 = performance.now()
      expandAll()
      const expandAllMs = performance.now() - t0
      const expandedRows = countRows()

      const t1 = performance.now()
      act(() => {
        useEditorStore.getState().hoverNode('s0-b0-l0')
      })
      const hoverCommitMs = performance.now() - t1

      const perRow = countRowSubscriptions()

      // Benchmark output, not app logging — this is the before/after column.
      console.warn(
        `[layers-perf] nodes=${TOTAL_NODES} rowsCollapsed=${collapsedRows} ` +
        `rowsExpanded=${expandedRows} subsPerRow=${perRow} ` +
        `selectorInvocationsPerCommit=${expandedRows * perRow} ` +
        `expandAllMs=${expandAllMs.toFixed(1)} hoverCommitMs=${hoverCommitMs.toFixed(1)}`,
      )

      // Budget: a 640px viewport at 28px rows fits ~23 rows; overscan is 8 rows
      // each way, so the mounted ceiling is 32 regardless of tree size.
      // Calibrated at 32, gated at 48 — enough headroom to raise OVERSCAN_ROWS
      // to 16, not enough to survive losing the window (2,441 pre-windowing).
      expect(expandedRows).toBeLessThanOrEqual(48)
    } finally {
      restore()
    }
  })

  it('keeps per-row store subscriptions in single digits', () => {
    const perRow = countRowSubscriptions()
    // Benchmark output, not app logging — this is the before/after column.
    console.warn(`[layers-perf] treeNodeStoreSubscriptions=${perRow}`)
    // Budget: everything that is a per-TREE fact (page, root id, VC names,
    // class registry, drag state, layer prefs, every store ACTION) belongs in
    // the list or in `getState()`, not in a per-row subscription. Exactly one
    // thing is genuinely per-row and hot: the hover flag. Calibrated at 1,
    // gated at 3; it was 17.
    expect(perRow).toBeLessThanOrEqual(3)
  })

  it('selector invocations per store commit stay bounded on a deep tree', () => {
    loadDeepSite()
    const { restore } = renderInScroller()
    try {
      expandAll()
      const invocations = countRows() * countRowSubscriptions()
      // Budget: rows x subscriptions — what every store commit pays before
      // React starts. Pre-windowing on this fixture: 2,441 x 17 = 41,497.
      // Calibrated at 32, gated at the product of the two budgets above.
      expect(invocations).toBeLessThanOrEqual(48 * 3)
    } finally {
      restore()
    }
  })
})
