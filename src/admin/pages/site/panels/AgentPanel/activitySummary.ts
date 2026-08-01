/**
 * What the agent is doing right now, derived from the streaming turn's blocks.
 *
 * The panel used to answer that question with the word "Working…" and nothing
 * else, for however long the turn took — which on a delegated task is minutes.
 * The information was always there: the blocks on the in-flight assistant
 * message record every tool the model called and every reasoning burst between
 * them. This turns that history into two things a person can actually read —
 * a single honest headline, and the list of steps behind it.
 *
 * Pure and React-free so the phrasing is testable without rendering: the
 * headline is the one piece of UI most likely to be wrong in a way nobody
 * notices (it is only visible while a turn is in flight).
 */

import type { AgentMessage, AgentToolCall } from '@site/agent'
import { getToolCallDisplay } from './toolCallDisplay'

export interface ActivityStep {
  key: string
  title: string
  detail: string
  status: AgentToolCall['status']
}

export interface ActivitySummary {
  /** One line, always present — what is happening at this instant. */
  headline: string
  /** Every tool step this turn has taken, oldest first. */
  steps: ActivityStep[]
  /** Steps already finished, for the "3 of 7" style summary. */
  completedCount: number
}

/**
 * The opening state, before the model has emitted anything at all. Deliberately
 * concrete rather than a bare spinner word: the gap between hitting send and
 * the first token is where a slow start is indistinguishable from a hang, and
 * it is the moment the CLI spends launching, loading `CLAUDE.md`, and shaking
 * hands with the MCP connector.
 */
const STARTING_HEADLINE = 'Getting started — reading your project'

export function summarizeAgentActivity(message: AgentMessage | null): ActivitySummary {
  if (!message) return { headline: STARTING_HEADLINE, steps: [], completedCount: 0 }

  const steps: ActivityStep[] = []
  for (const block of message.blocks) {
    if (block.kind !== 'toolCall') continue
    const display = getToolCallDisplay(block.toolCall.actionType, block.toolCall.params)
    steps.push({
      key: block.toolCall.id,
      title: display.title,
      detail: display.detail,
      status: block.toolCall.status,
    })
  }
  const completedCount = steps.filter((step) => step.status !== 'pending').length

  return { headline: headlineFor(message, steps), steps, completedCount }
}

/**
 * The headline names the newest thing that is genuinely still happening.
 *
 * A running tool wins over everything: it is the most specific and the most
 * likely to be slow. Otherwise the LAST block decides, because that is what
 * the model is doing at this instant — trailing text means it is answering,
 * trailing reasoning means it is still thinking.
 */
function headlineFor(message: AgentMessage, steps: ActivityStep[]): string {
  const running = steps.findLast((step) => step.status === 'pending')
  if (running) {
    return running.detail ? `${running.title} — ${running.detail}` : running.title
  }

  const last = message.blocks.at(-1)
  if (!last) return STARTING_HEADLINE
  if (last.kind === 'text') return 'Writing the answer'
  if (last.kind === 'reasoning') return 'Thinking it through'
  if (last.kind === 'toolCall') {
    // Every tool has finished and nothing new has started — the model is
    // deciding what to do with the results.
    return 'Working out the next step'
  }
  return STARTING_HEADLINE
}
