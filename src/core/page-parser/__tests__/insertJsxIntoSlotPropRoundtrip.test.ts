/**
 * E2.4's required end-to-end proof: a `insertJsxIntoSlotProp` write that
 * turns a single-element slot into a fragment-valued one must re-parse as
 * E2.3's `studio.slot` container (`fragmentSlot: true`) at the FRAGMENT's own
 * source location — never a canvas-minted id.
 *
 * That distinction has a precise, checked meaning, not just a vibe — two
 * separate gates read it, and they read it in OPPOSITE directions:
 *
 *  - `refuseMintedNodeInsert` (`@core/page-tree`, gates `applyTreeOperation`'s
 *    `insertNode` — the path a plugin/agent uses to add an ALREADY-MINTED
 *    node object to the in-memory tree) must REFUSE for this container.
 *    `applyTreeOperation.insertNode` always carries a minted (nanoid) node
 *    with no source location; if this container's OWN id were ALSO a nanoid
 *    (not source-derived), `refuseMintedNodeInsert` would read it as an
 *    ordinary CMS node and silently ALLOW the mint — the exact `struct-01`
 *    silent no-op this whole gate exists to prevent. Using the fragment's
 *    REAL `<` position instead of minting one is what keeps this refusing.
 *  - `refuseStructuralEdit({kind:'insert', node})` (`@core/page-tree`, the
 *    gate the STORE asks before a canvas "insert" gesture) must NOT refuse
 *    when asked about the CALL SITE — `insert-slot` fills one of the call
 *    site's own attributes, not the locked slot CONTENT. Asking the
 *    identical question about the slot container itself WOULD wrongly
 *    refuse `code-placed` (its `lockReason` is structural, on purpose — see
 *    E2.3's own `SLOT_LOCK_REASON`) — which is exactly "wall #3" from
 *    `STUDIO-FIGMA-PARITY-PLAN.md`'s E2 preamble ("nothing can be inserted
 *    into a slot"), and exactly why `insertJsxIntoSlotProp`'s location
 *    convention targets the call site, never the slot's own container id.
 *
 * Codemod (E2.4) and parser (E2.3) are owned by different tracks; this test
 * is the seam between them, written from the codemod side per E2.3's own
 * handoff ("E2.4 ... I did not write or test the codemod side").
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  parsePageFile,
  type ParsedNode,
} from '@core/page-parser'
import {
  decodeSourceNodeId,
  hasWritableSourceLocation,
  isSourceDerivedNodeId,
  refuseMintedNodeInsert,
  refuseStructuralEdit,
} from '@core/page-tree'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { insertJsxIntoSlotProp } from '../../ast-codemods/insertJsxIntoSlotProp'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-roundtrip-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function loadNodes(pageRel: string): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  return Object.values(
    parsePageFile(file, tmpDir, project, { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }).nodes,
  )
}

const named = (nodes: ParsedNode[], name: string): ParsedNode => {
  const found = nodes.find((n) => n.name === name)
  if (!found) throw new Error(`No node named ${name} in ${nodes.map((n) => n.name).join(', ')}`)
  return found
}

describe('insertJsxIntoSlotProp -> re-parse -> the two id-shaped gates (E2.4 required proof)', () => {
  it('a slot filled from single-element to fragment round-trips as a studio.slot container with a REAL, non-minted id', () => {
    const file = write(
      'pages/SheetLayout.jsx',
      [
        'export default function SheetLayout() {',
        '  return (',
        '    <Sheet',
        '      title="Where to?"',
        '      header={<BackButton />}',
        '    />',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // Before: a single-element slot value — the pre-E2.3 shape, zero parser
    // change needed for it.
    const before = named(loadNodes('pages/SheetLayout.jsx'), 'Sheet')
    expect(before.props.header).toBeDefined()

    const at = { line: 3, col: 6 } // the Sheet call site's own tag-name start
    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'span', children: 'Title' },
    })
    expect(result).toEqual({ ok: true })

    // The write itself: existing + new element, wrapped in a fragment.
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<>')
    expect(written).toContain('<BackButton />')
    expect(written).toContain('<span>Title</span>')
    expect(written).toContain('</>')

    // Re-parse — this is the seam. E2.3's parser must now capture the
    // fragment as a `studio.slot` container, not decline it.
    const nodes = loadNodes('pages/SheetLayout.jsx')
    const sheet = named(nodes, 'Sheet')
    const headerValue = sheet.props.header
    expect(typeof headerValue).toBe('string')
    const slotId = studioSlotNodeId(headerValue)
    expect(slotId).toBeDefined()
    expect(slotId).not.toBe(headerValue) // proves the sentinel prefix was actually present

    const container = nodes.find((n) => n.id === slotId)
    expect(container).toBeDefined()
    expect(container!.fragmentSlot).toBe(true)
    expect(container!.children.length).toBe(2)

    // The published id grammar: a real, decodable `rel:line:col` — the
    // fragment's OWN location — never a minted (nanoid) id.
    expect(isSourceDerivedNodeId(slotId!)).toBe(true)
    expect(hasWritableSourceLocation(slotId!)).toBe(true)
    expect(decodeSourceNodeId(slotId!)?.rel).toBe('pages/SheetLayout.jsx')

    // GATE 1 — `refuseMintedNodeInsert` must REFUSE `applyTreeOperation`'s
    // minted-node `insertNode` against this container. This is the CORRECT
    // direction: every node that op ever carries is minted (nanoid), so a
    // source-derived container must always refuse it — the only way to add
    // content here is `insert-slot`'s own source-writing path, never a
    // plugin handing over an already-built node object.
    const mintedRefusal = refuseMintedNodeInsert({ parent: container!, studioPageRoot: false })
    expect(mintedRefusal).not.toBeNull()
    expect(mintedRefusal!.reason).toBe('insert')

    // Negative control, proving the assertion above is discriminating
    // something real: an ordinary CMS-tree (nanoid) parent, which
    // `applyTreeOperation.insertNode` DOES support, is NOT refused here.
    expect(refuseMintedNodeInsert({ parent: { id: 'nanoidLooking123' }, studioPageRoot: false })).toBeNull()

    // GATE 2 — `refuseStructuralEdit`'s `insert` case is what the STORE asks
    // before a canvas "insert" gesture. The slot container itself is
    // STRUCTURALLY locked (`SLOT_LOCK_REASON`) — asking about it directly
    // would wrongly refuse `code-placed`, which is exactly "wall #3"
    // (`STUDIO-FIGMA-PARITY-PLAN.md`'s E2 preamble) —
    // `insertJsxIntoSlotProp`'s own location convention never asks this
    // question about the container; it targets the CALL SITE, which carries
    // no such lock:
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: `pages/SheetLayout.jsx:${at.line}:${at.col}` } })).toBeNull()
    // Proven wrong on purpose, for contrast: the slot container itself DOES
    // refuse if asked — confirming `insertJsxIntoSlotProp` is right to never
    // ask this question about it.
    expect(container!.lockReason).toBeDefined()
    const wrongGate = refuseStructuralEdit({ kind: 'insert', node: container! })
    expect(wrongGate).not.toBeNull()
    expect(wrongGate!.reason).toBe('code-placed')
  })
})
