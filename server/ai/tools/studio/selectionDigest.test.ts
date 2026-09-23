/**
 * AI-9 — the selection reaches the agent as source locations, excerpts and
 * boxes, for every selected node, not as one bare node id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { buildStudioLiveDigest } from './liveDigest'
import { createStalenessTracker } from './staleness'
import { buildSelectionDigest, describeSelection, MAX_SELECTION_DETAILED } from './selectionDigest'
import { buildStudioAgentSystemPrompt, type StudioPromptContext } from './systemPrompt'
import { studioAgentTools } from './index'
import type { StudioAgentSnapshot } from './snapshot'

const CHECKOUT = [
  "import styles from './Checkout.module.css'",
  '',
  'export default function Checkout() {',
  '  return (',
  '    <main className={styles.page}>',
  '      <h1 className={styles.title}>Your order</h1>',
  '      <button className={styles.pay}>Pay $42.00</button>',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const CTX: StudioPromptContext = {
  dir: 'fixture',
  name: 'fixture',
  trust: 'static',
  framework: 'react',
  pagesDir: 'pages',
  packageManager: 'bun',
  styleToolchain: { tailwind: false, sass: false, cssModules: true },
  componentPackages: [],
  warningCount: 0,
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-selection-digest-'))
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }))
  writeFileSync(join(dir, 'pages', 'Checkout.tsx'), CHECKOUT)
  writeFileSync(join(dir, 'pages', 'Checkout.module.css'), '.page { padding: 16px; }\n.title { font-size: 24px; }\n.pay { height: 48px; }\n')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function snapshot(selection: StudioAgentSnapshot['selection']): StudioAgentSnapshot {
  return {
    activeBoardId: 'board-1',
    frames: [{ pageId: 'checkout', x: 0, y: 0, width: 393, height: 852 }],
    activePageId: 'checkout',
    selection,
    axes: { direction: 'ltr', colorScheme: 'light' },
  }
}

describe('the selection digest (AI-9)', () => {
  it('a multi-selection reaches the prompt as every node\'s file:line, excerpt and box', async () => {
    const live = await buildStudioLiveDigest(
      dir,
      snapshot([
        { nodeId: 'pages/Checkout.tsx:6:8', box: { x: 24, y: 96, width: 345, height: 32 } },
        { nodeId: 'pages/Checkout.tsx:7:8' },
      ]),
      'conv-sel',
      { staleness: createStalenessTracker() },
    )
    const [, , suffix] = buildStudioAgentSystemPrompt(CTX, studioAgentTools, live)
    expect(suffix).toContain('Selected (2 nodes, the last is the primary):')
    expect(suffix).toContain('pages/Checkout.tsx:6:8 <h1>')
    expect(suffix).toContain('pages/Checkout.tsx:6:8; box 24,96 345x32')
    expect(suffix).toContain('pages/Checkout.tsx:7:8 <base.button>')
    expect(suffix).toContain('box unmeasured (studio_measure_element measures it)')
    // The excerpt is the node's own line with its neighbours, numbered.
    expect(suffix).toContain('7|       <button className={styles.pay}>Pay $42.00</button>')
    expect(suffix).toContain('6|       <h1 className={styles.title}>Your order</h1>')
  })

  it('one selected node reads as one line, and none as "Selected: none"', () => {
    const one = buildSelectionDigest(dir, null, [{ nodeId: 'pages/Checkout.tsx:7:8' }])
    expect(describeSelection(one)).toStartWith('Selected: pages/Checkout.tsx:7:8 (not on the active page); pages/Checkout.tsx:7:8')
    expect(describeSelection(buildSelectionDigest(dir, null, []))).toBe('Selected: none')
  })

  it('marks a .map row with its template location and says where each kind of edit lands', () => {
    const digest = buildSelectionDigest(dir, null, [{ nodeId: 'pages/Checkout.tsx:7:8#2' }])
    expect(digest.nodes[0]!.source).toEqual({ file: 'pages/Checkout.tsx', line: 7, col: 8, mapRow: true })
    expect(describeSelection(digest)).toContain('one row of a .map')
  })

  it('never reads outside the project for an excerpt, whatever the node id says', () => {
    const outside = `${dir}-outside`
    mkdirSync(outside, { recursive: true })
    try {
      writeFileSync(join(outside, 'Secret.tsx'), 'const TOKEN = "do-not-leak"\n')
      const digest = buildSelectionDigest(dir, null, [{ nodeId: `../${basename(outside)}/Secret.tsx:1:1` }])
      expect(digest.nodes[0]!.excerpt).toEqual([])
      expect(describeSelection(digest)).not.toContain('do-not-leak')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('is bounded: the most recent selections are detailed and the rest counted', () => {
    const many = Array.from({ length: MAX_SELECTION_DETAILED + 5 }, (_, i) => ({ nodeId: `pages/Checkout.tsx:${i + 1}:1` }))
    const digest = buildSelectionDigest(dir, null, many)
    expect(digest.nodes).toHaveLength(MAX_SELECTION_DETAILED)
    expect(digest.omitted).toBe(5)
    // The primary (last) is always kept.
    expect(digest.nodes[digest.nodes.length - 1]!.nodeId).toBe(`pages/Checkout.tsx:${MAX_SELECTION_DETAILED + 5}:1`)
    expect(describeSelection(digest)).toContain('(+5 earlier selections not shown)')
    // Only the last three carry an excerpt.
    expect(digest.nodes.filter((node) => node.excerpt.length > 0).length).toBeLessThanOrEqual(3)
  })
})
