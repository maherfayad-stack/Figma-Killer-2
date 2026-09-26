/**
 * What the assistant can see of the editor right now, as the panel shows it
 * (AI-28) — pure, React-free, testable.
 *
 * The turn already sends the selection (`studioAgentSnapshot.ts`) and the
 * server already turns it into `file:line`, an excerpt and a box for the model
 * (P4-D's selection digest). The person typing could not see any of that: the
 * selection travelled silently. The **selection chip** says what the agent
 * will be told about ("Button · Checkout.tsx:42 +2") and can be removed for the
 * next message. The **suggestion chips** replace an empty state that offered
 * one canned sentence with prompts built from what is actually on screen.
 */
import { decodeSourceNodeId } from '@core/page-tree'

export interface AgentLiveContext {
  /** Title of the page on screen, or `null` with none. */
  readonly activePageTitle: string | null
  /** The selection in store order — the LAST id is the primary one. */
  readonly selectedNodeIds: readonly string[]
  /** Display name of the primary selection (`getNodeDisplayName`), or `null` when it is not in a loaded page. */
  readonly primaryLabel: string | null
  /** Open (unresolved) review comments on the project. */
  readonly openCommentCount: number
}

export interface SelectionChip {
  /** "Button · Checkout.tsx:42" — what the agent will be pointed at. */
  readonly label: string
  /** "+2" when more than one node is selected. */
  readonly more: string | null
  /** Full path and line, for the tooltip. */
  readonly title: string
}

function fileLine(nodeId: string): { short: string; full: string } | null {
  const location = decodeSourceNodeId(nodeId)
  if (!location) return null
  const name = location.rel.split('/').at(-1) ?? location.rel
  return { short: `${name}:${location.line}`, full: `${location.rel}:${location.line}` }
}

export function selectionChip(context: AgentLiveContext): SelectionChip | null {
  const primary = context.selectedNodeIds.at(-1)
  if (!primary) return null
  const where = fileLine(primary)
  const name = context.primaryLabel ?? 'Selected layer'
  const extra = context.selectedNodeIds.length - 1
  return {
    label: where ? `${name} · ${where.short}` : name,
    more: extra > 0 ? `+${extra}` : null,
    title: where ? `${name} — ${where.full}${extra > 0 ? ` and ${extra} more` : ''}` : name,
  }
}

export interface SuggestionChip {
  readonly id: string
  /** Short, on the chip. */
  readonly label: string
  /** The message it sends, whole. */
  readonly prompt: string
}

/**
 * Up to four prompts that fit what is on screen: the selection first (the most
 * specific thing the user did), then the page, then open review comments, then
 * a from-scratch screen so the list is never empty.
 */
export function suggestionChips(context: AgentLiveContext): SuggestionChip[] {
  const chips: SuggestionChip[] = []
  const selected = context.selectedNodeIds.length
  if (selected > 0) {
    const subject = selected > 1 ? `these ${selected} layers` : (context.primaryLabel ?? 'the selected layer')
    chips.push({
      id: 'tighten-selection',
      label: `Tighten spacing on ${selected > 1 ? 'selection' : subject}`,
      prompt: `Tighten the spacing and alignment of ${subject} so it sits on the project's spacing scale. Keep everything else as it is.`,
    })
    chips.push({
      id: 'explain-selection',
      label: selected > 1 ? 'What are these?' : 'What is this?',
      prompt: `What ${selected > 1 ? 'are' : 'is'} ${subject}? Name the file and line, and what controls ${selected > 1 ? 'their' : 'its'} styles.`,
    })
  }
  if (context.activePageTitle) {
    chips.push({
      id: 'directions',
      label: `3 directions for ${context.activePageTitle}`,
      prompt: `Make 3 genuinely different design directions for the ${context.activePageTitle} screen, side by side on the board, each with a one-line note on its idea.`,
    })
    chips.push({
      id: 'dark-rtl',
      label: 'Check dark mode + RTL',
      prompt: `Check the ${context.activePageTitle} screen in dark mode and right-to-left, and fix anything that breaks.`,
    })
  }
  if (context.openCommentCount > 0) {
    chips.push({
      id: 'comments',
      label: `Address ${context.openCommentCount} open comment${context.openCommentCount === 1 ? '' : 's'}`,
      prompt: `Address the ${context.openCommentCount} open review comment${context.openCommentCount === 1 ? '' : 's'} on this project: make each change, reply in its thread saying what you did, and resolve it.`,
    })
  }
  chips.push({
    id: 'new-screen',
    label: 'Design a new screen',
    prompt: 'Design a new screen for this project. Ask me one question about what it is for first if you need to.',
  })
  return chips.slice(0, 4)
}
