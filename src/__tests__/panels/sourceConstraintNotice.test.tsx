/**
 * `SourceConstraintNotice` says one of exactly two whole-node things, and the
 * point of this suite is that it says the TRUE one and nothing more.
 *
 * Track F2 / R7 (`docs/audits/2026-08-06/09-refusal-states.md`) deleted the
 * THIRD variant this component used to render — "nothing structural at all,
 * only values came from code" — which fired on the MAJORITY of a real
 * imported board's nodes (149/276 on the eSIM corpus) to repeat what
 * `CodeValueControl`/`propLockReason` already say per field (R2). What's
 * left is the structural fact (`lockReason`) and the resolved-text-origin
 * fact (`textOrigin`), independently of each other.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { EditConstraint } from '@core/page-tree'
import { SourceConstraintNotice } from '@site/panels/PropertiesPanel/SourceConstraintNotice'

afterEach(cleanup)

const CANNOT_MOVE = /can't be moved or deleted/i

describe('SourceConstraintNotice', () => {
  it('a structurally locked element with a source location says so, and keeps its values editable', () => {
    render(<SourceConstraintNotice lockReason="spread props" hasWritableLocation />)

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('structure-locked')
    expect(notice.textContent).toMatch(CANNOT_MOVE)
    expect(notice.textContent).toContain('spread props')
  })

  it('a `.map` row says one piece of source renders every row', () => {
    render(<SourceConstraintNotice lockReason="item 2 of DEALS" hasWritableLocation={false} />)

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('list-row')
    expect(notice.textContent).toMatch(/One piece of source renders every row/)
  })

  it('renders nothing for an ordinary node — no structural lock, no textOrigin', () => {
    const { container } = render(<SourceConstraintNotice hasWritableLocation />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a code-valued-but-unlocked node either — that fact lives per-field now', () => {
    // The R7 regression this pins: a node whose ONLY fact is "some prop
    // resolved from an expression" must NOT get a node-level paragraph
    // repeating what `CodeValueControl` already says next to that field.
    const { container } = render(<SourceConstraintNotice hasWritableLocation />)
    expect(container.firstChild).toBeNull()
  })

  it('states where resolved text writes, and how many places it changes, with a clickable jump-to-source', () => {
    render(
      <SourceConstraintNotice
        hasWritableLocation
        textOrigin={{ rel: 'src/i18n/translations.js', line: 142, col: 18 }}
        sharedWith={5}
      />,
    )

    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.dataset.variant).toBe('text-origin-only')
    expect(notice.textContent).toContain('src/i18n/translations.js')
    expect(notice.textContent).toContain('142')
    expect(notice.textContent).toMatch(/changes all\s*5\s*places/)
    // R8 — the file:line mention is a real button, not plain text.
    expect(screen.getByRole('button', { name: /translations\.js/ })).toBeTruthy()
  })

  it('a textOrigin with no sharing count omits the "changes all N places" clause', () => {
    render(
      <SourceConstraintNotice
        hasWritableLocation
        textOrigin={{ rel: 'src/i18n/translations.js', line: 142, col: 18 }}
      />,
    )
    expect(screen.getByTestId('source-constraint-notice').textContent).not.toMatch(/changes all/)
  })

  it('shows BOTH facts when a node is structurally locked AND has a resolved text origin', () => {
    render(
      <SourceConstraintNotice
        lockReason="item 2 of DEALS"
        hasWritableLocation={false}
        textOrigin={{ rel: 'src/i18n/translations.js', line: 142, col: 18 }}
      />,
    )
    const notice = screen.getByTestId('source-constraint-notice')
    expect(notice.textContent).toMatch(/One piece of source renders every row/)
    expect(notice.textContent).toContain('src/i18n/translations.js')
  })

  // R3 (`STUDIO-LIVE-CANVAS-PLAN.md` Track R) — the structural half used to
  // stop at the sentence. When the caller hands over a real `EditConstraint`
  // (`refusePlacement` + `describeStructuralRefusal`), the SAME remedy
  // buttons `LayerNodeContextMenu`'s footer renders must show up here too.
  describe('R3 — real remedy buttons for the structural half', () => {
    const sharedComponentConstraint: EditConstraint = {
      reason: 'shared-component',
      scope: 'node',
      explanation: "markup that lives in a shared component's own file",
      origin: { rel: 'src/components/Header.tsx', line: 8, col: 1 },
      actions: [
        { label: 'Open the component definition', kind: 'edit-component', target: { rel: 'src/components/Header.tsx', line: 8, col: 1 } },
        { label: 'Detach this instance', kind: 'detach' },
        { label: 'Duplicate as a new file and edit that', kind: 'extract' },
      ],
    }

    it('renders every action as a real button, below the bespoke prose', () => {
      render(
        <SourceConstraintNotice
          lockReason="from Header.tsx"
          hasWritableLocation
          constraint={sharedComponentConstraint}
          nodeId="node-1"
        />,
      )

      const notice = screen.getByTestId('source-constraint-notice')
      // The hand-written prose is still there — the nuance an `EditConstraint`
      // alone doesn't carry.
      expect(notice.textContent).toMatch(CANNOT_MOVE)
      expect(screen.getByRole('button', { name: /open the component definition/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /detach this instance/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /duplicate as a new file/i })).toBeTruthy()
    })

    it('renders nothing extra when the constraint has no actions', () => {
      const noActions: EditConstraint = {
        reason: 'code-placed',
        scope: 'node',
        explanation: 'The code decides where this element goes.',
        actions: [],
      }
      render(
        <SourceConstraintNotice lockReason="code-placed" hasWritableLocation constraint={noActions} />,
      )
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})
