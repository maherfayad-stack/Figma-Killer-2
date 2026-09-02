/**
 * `summarizeAgentActivity` — the headline and step list behind the AgentPanel's
 * live activity strip.
 *
 * Worth testing precisely because it is only ever visible mid-turn: a wrong
 * headline is invisible in review, invisible in a screenshot taken after the
 * turn, and the whole reason the feature exists is that the previous answer
 * ("Working…") told the user nothing.
 */
import { describe, expect, it } from 'bun:test'
import { summarizeAgentActivity } from '@site/panels/AgentPanel/activitySummary'
import type { AgentMessage, AgentToolCall } from '@site/agent'

function toolCall(overrides: Partial<AgentToolCall> & { actionType: string }): AgentToolCall {
  return {
    id: overrides.actionType + (overrides.externalId ?? ''),
    actionType: overrides.actionType,
    params: {},
    result: null,
    status: 'pending',
    ...overrides,
  }
}

function assistant(blocks: AgentMessage['blocks']): AgentMessage {
  return { id: 'a1', role: 'assistant', blocks, timestamp: Date.now() }
}

describe('summarizeAgentActivity', () => {
  it('reassures with something concrete before the model has emitted anything', () => {
    expect(summarizeAgentActivity(assistant([])).headline).toBe('Getting started — reading your project')
    expect(summarizeAgentActivity(null).headline).toBe('Getting started — reading your project')
  })

  it('names the running tool and its target', () => {
    const activity = summarizeAgentActivity(assistant([
      { kind: 'toolCall', toolCall: toolCall({ actionType: 'Read', params: { file_path: 'C:\\proj\\src\\SelectPackageSheet.jsx' } }) },
    ]))
    // The basename, not the absolute path — this line lives in a 320px panel.
    expect(activity.headline).toBe('Reading — SelectPackageSheet.jsx')
  })

  // The single most useful thing the panel can say during a long task: which
  // agent is doing the work. The CLI's Task tool carries both in its params.
  it('names the subagent a Task delegates to', () => {
    const activity = summarizeAgentActivity(assistant([
      {
        kind: 'toolCall',
        toolCall: toolCall({
          actionType: 'Task',
          params: { subagent_type: 'studio-implementer', description: 'Build the eSIM page' },
        }),
      },
    ]))
    expect(activity.headline).toBe('Delegating to studio-implementer — Build the eSIM page')
  })

  it('prefers a still-running tool over trailing reasoning', () => {
    const activity = summarizeAgentActivity(assistant([
      { kind: 'toolCall', toolCall: toolCall({ actionType: 'Glob', params: { pattern: '**/*.jsx' }, status: 'pending' }) },
      { kind: 'reasoning', text: 'Now let me think about this' },
    ]))
    expect(activity.headline).toBe('Finding files — **/*.jsx')
  })

  it('falls back to the last block once every tool has finished', () => {
    const finished = toolCall({ actionType: 'Glob', status: 'success' })
    expect(summarizeAgentActivity(assistant([
      { kind: 'toolCall', toolCall: finished },
      { kind: 'reasoning', text: 'thinking' },
    ])).headline).toBe('Thinking it through')

    expect(summarizeAgentActivity(assistant([
      { kind: 'toolCall', toolCall: finished },
      { kind: 'text', text: 'Here is what I did' },
    ])).headline).toBe('Writing the answer')

    expect(summarizeAgentActivity(assistant([
      { kind: 'toolCall', toolCall: finished },
    ])).headline).toBe('Working out the next step')
  })

  it('lists every step in order and counts the finished ones', () => {
    const activity = summarizeAgentActivity(assistant([
      { kind: 'toolCall', toolCall: toolCall({ actionType: 'Glob', externalId: '1', status: 'success' }) },
      { kind: 'reasoning', text: 'ignored — not a step' },
      { kind: 'toolCall', toolCall: toolCall({ actionType: 'Read', externalId: '2', status: 'error' }) },
      { kind: 'toolCall', toolCall: toolCall({ actionType: 'Edit', externalId: '3', status: 'pending' }) },
    ]))
    expect(activity.steps.map((s) => s.title)).toEqual(['Finding files', 'Reading', 'Editing'])
    // A failed step is finished, not still running — the count tracks progress,
    // not success.
    expect(activity.completedCount).toBe(2)
  })
})
