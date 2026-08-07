/**
 * Architecture Gate — the Studio agent holds no subagent dispatch, and its
 * prompt does not pretend otherwise.
 *
 * ## What this used to guard, and why it is now a different gate
 *
 * `Task` was one of only two native tools the driver granted, and the CLI does
 * NOT error on an unknown `subagent_type` — it silently falls back to its own
 * built-in `general-purpose` agent, whose description advertises "file
 * editing, writing, and bash". None of those existed under the old `--tools`
 * ceiling, so the fallback ran, wrote nothing, and returned as if it had
 * worked. Observed exactly that way: the agent delegated screen authoring to
 * an invented `studio-implementer`, reported ten files written in detail, and
 * every one of them was still an untouched scaffold.
 *
 * The old defence was to list the real roster names in the prompt and gate
 * that the list stayed true. That only ever narrowed the odds — a model can
 * still name something not on a list. The real fix was to remove `Task` from
 * the tool surface entirely (`claudeCliToolSurface.ts`), which makes the
 * failure unreachable rather than merely discouraged, and to give the agent
 * native file tools so there is nothing a screen-building subagent would add
 * but latency.
 *
 * So this gate now enforces the two halves of that fix together: the driver
 * never grants `Task` on any turn shape, and the prompt never advertises
 * delegation the agent cannot perform. A prompt describing a capability the
 * session does not hold is the exact shape of the original bug.
 */
import { describe, expect, it } from 'bun:test'
import { buildStudioAgentSystemPrompt } from '../../../server/ai/tools/studio/systemPrompt'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { resolveNativeToolAllowlist } from '../../../server/ai/drivers/claudeCliToolSurface'

describe('the Studio agent holds no subagent dispatch', () => {
  it('never grants Task, with or without a project open, with or without attachments', () => {
    for (const workspaceCwd of ['/tmp/some-project', null]) {
      for (const hasAttachments of [true, false]) {
        const granted = resolveNativeToolAllowlist(workspaceCwd, hasAttachments).split(',').filter(Boolean)
        expect(granted).not.toContain('Task')
      }
    }
  })

  it('never grants Bash either — the one tool the project cwd does not bound', () => {
    for (const workspaceCwd of ['/tmp/some-project', null]) {
      for (const hasAttachments of [true, false]) {
        const granted = resolveNativeToolAllowlist(workspaceCwd, hasAttachments).split(',').filter(Boolean)
        expect(granted).not.toContain('Bash')
      }
    }
  })

  it('grants the file tools when a project is open, so authoring needs no delegation', () => {
    const granted = resolveNativeToolAllowlist('/tmp/some-project', false).split(',')
    expect(granted).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  })

  it('the prompt states plainly that there are no subagents', () => {
    expect(buildStudioAgentSystemPrompt(null, studioAgentTools)[0]!).toContain('no subagents')
  })

  it('the prompt never tells the model to delegate', () => {
    const staticPrefix = buildStudioAgentSystemPrompt(null, studioAgentTools)[0]!.toLowerCase()
    // `subagent_type` is the parameter name; `Task(` is the call shape. Either
    // one appearing means the prompt is describing a tool the session withheld.
    expect(staticPrefix).not.toContain('subagent_type')
    expect(staticPrefix).not.toContain('delegate to')
  })
})
