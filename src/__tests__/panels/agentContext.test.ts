/**
 * AI-28 — the context chips: the selection the agent will be told about, and
 * suggestions built from what is on screen.
 */
import { describe, expect, it } from 'bun:test'
import { selectionChip, suggestionChips, type AgentLiveContext } from '@site/panels/AgentPanel/agentContext'

const empty: AgentLiveContext = { activePageTitle: null, selectedNodeIds: [], primaryLabel: null, openCommentCount: 0 }

describe('selectionChip', () => {
  it('names the primary (last) selection with its file:line, and counts the rest', () => {
    const chip = selectionChip({ ...empty, selectedNodeIds: ['pages/Other.tsx:3:5', 'pages/Checkout.tsx:42:7'], primaryLabel: 'Button' })
    expect(chip).toEqual({ label: 'Button · Checkout.tsx:42', more: '+1', title: 'Button — pages/Checkout.tsx:42 and 1 more' })
  })

  it('is absent with nothing selected', () => {
    expect(selectionChip(empty)).toBeNull()
  })
})

describe('suggestionChips', () => {
  it('leads with the selection, then the page, and always offers a starting point', () => {
    const chips = suggestionChips({ activePageTitle: 'Checkout', selectedNodeIds: ['pages/Checkout.tsx:4:2'], primaryLabel: 'Hero', openCommentCount: 2 })
    expect(chips.map((c) => c.id)).toEqual(['tighten-selection', 'explain-selection', 'directions', 'dark-rtl'])
    expect(chips[2]!.prompt).toContain('Checkout')
  })

  it('offers the open comments when there is room', () => {
    const chips = suggestionChips({ ...empty, openCommentCount: 3 })
    expect(chips.map((c) => c.label)).toEqual(['Address 3 open comments', 'Design a new screen'])
  })
})
