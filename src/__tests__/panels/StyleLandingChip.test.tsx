/**
 * StyleLandingChip — the sentence for each rung, and who it speaks for.
 *
 * The chip reads what the server reported after a save (`styleLandings.ts`);
 * `styleLadderRealSource.test.tsx` proves the join from a real write. These
 * cases pin the words, the subject rules (a node's own inline layer and the
 * classes it carries, newest wins), and that Undo exists only where a plain
 * "set the old value back" cannot undo the write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { styleLandingText } from '@core/page-tree'
import { StyleLandingChip } from '@site/panels/PropertiesPanel/StyleLandingChip'
import { recordStyleLandings, resetStyleLandings } from '@site/studio/styleLandings'

const TOKEN = 'a'.repeat(32)

beforeEach(() => resetStyleLandings())
afterEach(() => {
  cleanup()
  resetStyleLandings()
})

describe('styleLandingText', () => {
  it.each([
    [{ rung: 'rule', file: 'src/screens/Card.module.css' }, 'Saved in Card.module.css'],
    [{ rung: 'expanded', file: 'src/Card.css' }, 'Saved in Card.css, shorthand expanded'],
    [{ rung: 'override', file: 'src/Card.css' }, 'Saved as an override in Card.css'],
    [{ rung: 'inline', file: 'src/Card.tsx' }, 'Saved inline'],
  ] as const)('%j reads %s', (landing, text) => {
    expect(styleLandingText(landing)).toBe(text)
  })
})

describe('StyleLandingChip', () => {
  it('says nothing before a write has landed', () => {
    render(<StyleLandingChip nodeId="a.tsx:1:1" classIds={['sc-card']} />)
    expect(screen.queryByTestId('style-landing-chip')).toBeNull()
  })

  it('speaks for a class the node carries, joined through the save plan', () => {
    render(<StyleLandingChip nodeId="a.tsx:1:1" classIds={['sc-card']} />)
    act(() => {
      recordStyleLandings(
        [{ nodeId: 'css:src/Card.css#.card##color', rung: 'rule', file: 'src/Card.css' }],
        { 'css:src/Card.css#.card##color': ['sc-card'] },
        undefined,
      )
    })
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved in Card.css')
    expect(screen.getByTestId('style-landing-chip').getAttribute('data-rung')).toBe('rule')
  })

  it('speaks for the node itself when the edit was inline', () => {
    render(<StyleLandingChip nodeId="a.tsx:1:1" classIds={[]} />)
    act(() => recordStyleLandings([{ nodeId: 'a.tsx:1:1', rung: 'inline', file: 'a.tsx' }], {}, undefined))
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved inline')
  })

  it("speaks for a .map row through the row template its inline style was written to", () => {
    render(<StyleLandingChip nodeId="pages/List.tsx:7:9#2" classIds={[]} />)
    act(() => recordStyleLandings([{ nodeId: 'pages/List.tsx:7:9', rung: 'inline', file: 'pages/List.tsx' }], {}, undefined))
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved inline')
  })

  it('ignores a landing for a different node or class', () => {
    render(<StyleLandingChip nodeId="a.tsx:1:1" classIds={['sc-card']} />)
    act(() => {
      recordStyleLandings([{ nodeId: 'b.tsx:9:9', rung: 'inline', file: 'b.tsx' }], {}, undefined)
      recordStyleLandings([{ nodeId: 'css:x', rung: 'rule', file: 'x.css' }], { 'css:x': ['sc-other'] }, undefined)
    })
    expect(screen.queryByTestId('style-landing-chip')).toBeNull()
  })

  it('the newest landing among the node and its classes wins', () => {
    render(<StyleLandingChip nodeId="a.tsx:1:1" classIds={['sc-card']} />)
    act(() => {
      recordStyleLandings([{ nodeId: 'css:c', rung: 'override', file: 'src/Card.css' }], { 'css:c': ['sc-card'] }, TOKEN)
      recordStyleLandings([{ nodeId: 'a.tsx:1:1', rung: 'inline', file: 'a.tsx' }], {}, undefined)
    })
    expect(screen.getByTestId('style-landing-chip').textContent).toBe('Saved inline')
    expect(screen.queryByTestId('style-landing-undo')).toBeNull()
  })

  it('offers Undo only for the rungs a value-set cannot take back, and only with a journal token', () => {
    render(<StyleLandingChip nodeId={null} classIds={['sc-card']} />)
    act(() => recordStyleLandings([{ nodeId: 'css:c', rung: 'override', file: 'src/Card.css' }], { 'css:c': ['sc-card'] }, TOKEN))
    expect(screen.getByTestId('style-landing-undo')).toBeTruthy()

    act(() => recordStyleLandings([{ nodeId: 'css:c', rung: 'override', file: 'src/Card.css' }], { 'css:c': ['sc-card'] }, undefined))
    expect(screen.queryByTestId('style-landing-undo')).toBeNull()

    act(() => recordStyleLandings([{ nodeId: 'css:c', rung: 'rule', file: 'src/Card.css' }], { 'css:c': ['sc-card'] }, TOKEN))
    expect(screen.queryByTestId('style-landing-undo')).toBeNull()
  })
})
