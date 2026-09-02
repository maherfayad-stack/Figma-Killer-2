/**
 * editConstraint — exhaustive coverage of the discriminated union: every
 * `explain*` function either returns `null` (writable) or an `EditConstraint`
 * whose `explanation` is non-empty and whose `actions` array is present
 * (possibly deliberately empty — a terminal refusal, not a missing one).
 *
 * The R2 regression this track fixes gets its own describe block: a node
 * with TWO code-valued props must show each prop's own real source, not one
 * real source and one generic "set in code" fallback.
 */
import { describe, expect, it } from 'bun:test'
import {
  explainClassNameConstraint,
  explainCssRuleConstraint,
  explainDetachConstraint,
  explainGestureConstraint,
  explainInstanceDuplicateConstraint,
  explainMintedInsertConstraint,
  explainPropConstraint,
  explainStructuralConstraint,
  explainStyleConstraint,
  explainSwapConstraint,
  explainUnexplainedSkip,
  type EditConstraint,
} from '../editConstraint'
import type { StructuralMovePreview } from '../sourceStructure'

/** Every non-null constraint must carry a real sentence and a real (possibly empty) actions array. */
function assertWellFormed(constraint: EditConstraint | null): asserts constraint is EditConstraint {
  expect(constraint).not.toBeNull()
  if (!constraint) return
  expect(constraint.explanation.length).toBeGreaterThan(0)
  expect(Array.isArray(constraint.actions)).toBe(true)
}

// ---------------------------------------------------------------------------
// R2 — the regression this track fixes: two code-valued props on one node,
// each must show its OWN source, not a shared/generic fallback.
// ---------------------------------------------------------------------------

describe('R2 — per-prop resolution, not the node-level "first resolution" fallback', () => {
  it('two code-valued props each get their own explanation', () => {
    const node = {
      lockReason: undefined,
      codeProps: ['title', 'subtitle'],
      resolvedProps: {
        title: { source: 'c.heading' },
        subtitle: { source: 'c.tagline', note: 'picked the "en" branch' },
      },
    }

    const titleConstraint = explainPropConstraint(node, 'title')
    const subtitleConstraint = explainPropConstraint(node, 'subtitle')

    assertWellFormed(titleConstraint)
    assertWellFormed(subtitleConstraint)

    expect(titleConstraint.explanation).toContain('c.heading')
    expect(subtitleConstraint.explanation).toContain('c.tagline')
    expect(subtitleConstraint.explanation).toContain('picked the "en" branch')
    // The old bug: the second prop fell back to a generic string identical
    // for every code-valued prop on the node, losing its own source entirely.
    expect(titleConstraint.explanation).not.toBe(subtitleConstraint.explanation)
    expect(subtitleConstraint.explanation).not.toBe('Set in code.')
  })

  it('a prop with no resolvedProps entry still gets an honest, non-lying fallback', () => {
    const node = { codeProps: ['icon'], resolvedProps: {} }
    const constraint = explainPropConstraint(node, 'icon')
    assertWellFormed(constraint)
    expect(constraint.explanation).toBe('Set in code.')
  })

  it('a writable prop returns null', () => {
    const node = { codeProps: ['title'], resolvedProps: { title: { source: 'c.heading' } } }
    expect(explainPropConstraint(node, 'subtitle')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Prop scope — rows 1, 2, 3(list-row via prop), 28 (coarse but same mechanism)
// ---------------------------------------------------------------------------

describe('explainPropConstraint', () => {
  it('row 2 — a structured value refuses with no resolvedProps needed', () => {
    const node = { codeProps: ['actions'] }
    const constraint = explainPropConstraint(node, 'actions', [{ label: 'a' }, { label: 'b' }])
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('structured-value')
    expect(constraint.actions).toEqual([])
  })

  it('row 3 — a `.map` row with a real id refuses with the structural wording and a best-effort jump action', () => {
    const node = { id: 'src/screens/Home.jsx:70:21#2', codeProps: ['title'] }
    const constraint = explainPropConstraint(node, 'title')
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('list-row')
    expect(constraint.explanation).toContain('row of a list')
    // No `origin` — a `.map` row has no SINGLE honest source location (that is
    // what "no writable source location" means); the action below still
    // carries a real, useful-but-imprecise jump target.
    expect(constraint.origin).toBeUndefined()
    expect(constraint.actions.length).toBeGreaterThan(0)
    expect(constraint.actions[0]?.kind).toBe('edit-array')
    expect(constraint.actions[0]?.target?.rel).toBe('src/screens/Home.jsx')
  })

  it('a `callSiteProps:` namespaced key (WS-4.2 instance) is looked up literally', () => {
    const node = {
      codeProps: ['callSiteProps:title'],
      resolvedProps: { 'callSiteProps:title': { source: 'plan.name' } },
    }
    const constraint = explainPropConstraint(node, 'callSiteProps:title')
    assertWellFormed(constraint)
    expect(constraint.explanation).toContain('plan.name')
  })
})

// ---------------------------------------------------------------------------
// Style scope — rows 5, 6
// ---------------------------------------------------------------------------

describe('explainStyleConstraint', () => {
  it('row 6 — whole node has no writable location at all', () => {
    const node = { id: 'src/screens/Home.jsx:70:21#2', codeProps: ['style:color'] }
    const constraint = explainStyleConstraint(node, 'color')
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('no-inline-style-target')
    expect(constraint.explanation).toContain('Assign a class instead')
  })

  it('row 5 — a resolved style expression names its source', () => {
    const node = {
      id: 'src/screens/Home.jsx:12:4',
      codeProps: ['style:width'],
      resolvedProps: { 'style:width': { source: '`${pct}%`' } },
    }
    const constraint = explainStyleConstraint(node, 'width')
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('resolved-style-expression')
    expect(constraint.explanation).toContain('pct')
  })

  it('a writable style property returns null', () => {
    expect(explainStyleConstraint({}, 'color')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Structural scope — rows 7-18 (StructuralRefusalReason absorbed verbatim)
// ---------------------------------------------------------------------------

describe('explainStructuralConstraint', () => {
  it('row 7 — list-row delete refusal carries a best-effort jump-to-source action, no single-truth origin', () => {
    const node = { id: 'src/screens/Home.jsx:70:21#2' }
    const constraint = explainStructuralConstraint({ kind: 'delete', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('list-row')
    expect(constraint.origin).toBeUndefined()
    expect(constraint.actions[0]?.kind).toBe('edit-array')
    expect(constraint.actions[0]?.target?.rel).toBe('src/screens/Home.jsx')
  })

  it('row 8 — shared-component delete refusal offers a detach action', () => {
    const node = { id: 'pages/Home.jsx:77:19~components/Icon.jsx:3:6' }
    const constraint = explainStructuralConstraint({ kind: 'delete', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('shared-component')
    expect(constraint.actions.some((a) => a.kind === 'detach')).toBe(true)
  })

  it('row 9 — route-chrome refuses with no action (honestly terminal)', () => {
    const node = { id: 'app/layout.tsx:5:3' }
    const constraint = explainStructuralConstraint({ kind: 'delete', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('route-chrome')
    expect(constraint.actions).toEqual([])
  })

  it('row 10 — code-placed refuses with no action', () => {
    const node = { id: 'src/screens/Home.jsx:9:1', lockReason: 'one branch of several — chosen in code' }
    const constraint = explainStructuralConstraint({ kind: 'delete', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('code-placed')
    expect(constraint.explanation).toContain('one branch of several')
  })

  it('row 11 — reparent refuses on any source-derived node with no action', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    const constraint = explainStructuralConstraint({ kind: 'reparent', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('reparent')
    expect(constraint.actions).toEqual([])
  })

  it('row 12 — duplicate refuses on ANY source-derived node (ordinary elements: no action)', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    const constraint = explainStructuralConstraint({ kind: 'duplicate', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('duplicate')
    expect(constraint.actions).toEqual([])
  })

  it('row 12 (instance escape hatch, R5) — a studio.instance gets the extract offer instead', () => {
    const constraint = explainInstanceDuplicateConstraint()
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('duplicate')
    expect(constraint.actions.some((a) => a.kind === 'extract')).toBe(true)
  })

  it('row 13 — wrap refuses on any source-derived node with no action', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    const constraint = explainStructuralConstraint({ kind: 'wrap', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('wrap')
    expect(constraint.actions).toEqual([])
  })

  it('row 14 — multi-select reorder refuses with an actionable instruction', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    const anchor = { id: 'src/screens/Home.jsx:11:1' }
    const constraint = explainStructuralConstraint({ kind: 'reorder', node, anchor, multi: true })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('multi-select')
    expect(constraint.actions[0]?.label).toContain('one by one')
  })

  it('row 15 — no-sibling-anchor refuses with no action', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    const constraint = explainStructuralConstraint({ kind: 'reorder', node, anchor: null })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('no-sibling-anchor')
    expect(constraint.actions).toEqual([])
  })

  it('row 16 — cross-file reorder refuses with no action', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    const anchor = { id: 'src/screens/Other.jsx:2:1' }
    const constraint = explainStructuralConstraint({ kind: 'reorder', node, anchor })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('cross-file')
  })

  it('row 17 — insert into a list-row container reuses the identical list-row wording/action', () => {
    // `refuseStructuralEdit({kind:'insert'})` never itself produces
    // `reason:'insert'` — that reason is `refuseMintedNodeInsert`'s own
    // (see `explainMintedInsertConstraint`) and `previewCanvasOnlyNodeIntoSourceRefusal`'s
    // (see `explainGestureConstraint`). An insert into a container the parser
    // marked unwritable refuses with the SAME `list-row`/`shared-component`/
    // `route-chrome`/`code-placed` facts a reorder or delete would.
    const node = { id: 'src/screens/Home.jsx:70:21#2' }
    const constraint = explainStructuralConstraint({ kind: 'insert', node })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('list-row')
    expect(constraint.actions[0]?.kind).toBe('edit-array')
  })

  it('an ordinary plain-element delete is NOT refused (returns null)', () => {
    const node = { id: 'src/screens/Home.jsx:9:1' }
    expect(explainStructuralConstraint({ kind: 'delete', node })).toBeNull()
  })

  it('a CMS (non-source-derived) node is never refused', () => {
    const node = { id: 'V1StGXR8Z5jdHi6BmyT' }
    expect(explainStructuralConstraint({ kind: 'duplicate', node })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Row 18 — minted-node insert refusal
// ---------------------------------------------------------------------------

describe('explainMintedInsertConstraint', () => {
  it('refuses a canvas-only node dropped into a source-backed parent, with a picker action', () => {
    const constraint = explainMintedInsertConstraint({
      parent: { id: 'src/screens/Home.jsx:9:1' },
      studioPageRoot: false,
    })
    assertWellFormed(constraint)
    expect(constraint.reason).toBe('insert')
    expect(constraint.actions[0]?.label).toContain('picker')
  })

  it('does not refuse into an ordinary CMS container', () => {
    expect(explainMintedInsertConstraint({ parent: { id: 'nanoid123' }, studioPageRoot: false })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Gesture scope — the drag-preview seam this track owns, consuming D2's
// published `previewStructuralMove` contract.
// ---------------------------------------------------------------------------

describe('explainGestureConstraint (scope: gesture, D2 seam)', () => {
  it('translates a refused preview into an EditConstraint', () => {
    const preview: StructuralMovePreview = {
      ok: false,
      refusal: { reason: 'shared-component', message: 'Moved markup that lives in a shared component…' },
    }
    const node = { id: 'pages/Home.jsx:77:19~components/Icon.jsx:3:6' }
    const constraint = explainGestureConstraint(preview, node)
    assertWellFormed(constraint)
    expect(constraint.scope).toBe('gesture')
    expect(constraint.reason).toBe('shared-component')
  })

  it('an ok preview returns null', () => {
    const preview: StructuralMovePreview = { ok: true, commit: null }
    expect(explainGestureConstraint(preview, { id: 'src/screens/Home.jsx:9:1' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Absorbed vocabularies — Detach (19-21), className (B2), CSS (B1/B1b),
// unexplained-skip (23).
// ---------------------------------------------------------------------------

describe('absorbed vocabularies — no parallel reasons invented', () => {
  it('row 19 — a non-extractable Detach reason carries no action', () => {
    const constraint = explainDetachConstraint('not-a-component', 'The call target is not a local component.')
    assertWellFormed(constraint)
    expect(constraint.actions).toEqual([])
  })

  it('row 20 — an extractable Detach reason offers the real hatch', () => {
    const constraint = explainDetachConstraint('uses-hooks', 'The component calls a hook.')
    assertWellFormed(constraint)
    expect(constraint.actions[0]?.kind).toBe('extract')
  })

  it('row 21 — name-collision carries no action', () => {
    const constraint = explainDetachConstraint('name-collision', 'A binding with that name already exists.')
    assertWellFormed(constraint)
    expect(constraint.actions).toEqual([])
  })

  it('B2 — css-module-binding offers "edit the class definition"', () => {
    const constraint = explainClassNameConstraint('css-module-binding', 'className reads a CSS Modules import.')
    assertWellFormed(constraint)
    expect(constraint.actions.length).toBeGreaterThan(0)
  })

  it('B2 — template-dynamic/unsupported-call/unsupported-expression/spread-attribute all well-formed with no action', () => {
    for (const reason of ['template-dynamic', 'unsupported-call', 'unsupported-expression', 'spread-attribute']) {
      const constraint = explainClassNameConstraint(reason, `refused: ${reason}`)
      assertWellFormed(constraint)
      expect(constraint.actions).toEqual([])
    }
  })

  it('B1/B1b — no-editable-stylesheet offers "style the element instead"', () => {
    const constraint = explainCssRuleConstraint('no-editable-stylesheet', 'This class has no hand-editable source.')
    assertWellFormed(constraint)
    expect(constraint.actions[0]?.kind).toBe('style-inline-instead')
  })

  it('B1/B1b — ambiguous-stylesheet and stylesheet-import-shape-mismatch also offer the inline hatch', () => {
    for (const reason of ['ambiguous-stylesheet', 'stylesheet-import-shape-mismatch']) {
      const constraint = explainCssRuleConstraint(reason, `refused: ${reason}`)
      assertWellFormed(constraint)
      expect(constraint.actions[0]?.kind).toBe('style-inline-instead')
    }
  })

  it('row 26 — breakpoint-override-unsupported carries no action (told, not fixed)', () => {
    const constraint = explainCssRuleConstraint('breakpoint-override-unsupported', 'Breakpoint override not saved to source.')
    assertWellFormed(constraint)
    expect(constraint.actions).toEqual([])
  })

  it('row 22 — swap refusal passes the codemod\'s own reason/message through', () => {
    const constraint = explainSwapConstraint('shape-mismatch', 'The candidate has a different prop shape.')
    assertWellFormed(constraint)
    expect(constraint.explanation).toContain('different prop shape')
    expect(constraint.actions).toEqual([])
  })

  it('row 23 — unexplained-skip is informational only, singular vs. plural wording', () => {
    const one = explainUnexplainedSkip(1)
    const many = explainUnexplainedSkip(3)
    expect(one.explanation).toContain('1 edit')
    expect(many.explanation).toContain('3 edits')
    expect(one.actions).toEqual([])
  })
})
