/**
 * Architecture Gate — the Studio agent may delegate, but only in the one shape
 * that cannot silently fabricate, and its prompt must describe exactly the
 * tools the session actually grants.
 *
 * ## The failure this exists to prevent
 *
 * The CLI does NOT error on an unknown `subagent_type` — it silently falls
 * back to its own built-in `general-purpose` agent and returns as if the work
 * had happened. Observed exactly that way: the agent delegated screen
 * authoring to an invented `studio-implementer`, reported ten files written in
 * detail, and every one of them was still an untouched scaffold.
 *
 * The first fix was to remove `Task` from the tool surface entirely, which
 * made the failure unreachable. It also made every multi-screen board strictly
 * sequential — three screens, 45 minutes, 154 turns, for work that shares no
 * file. So `Task` is back, and the fabrication is prevented at its actual
 * cause instead: the prompt must name `'general-purpose'` — the CLI's own
 * built-in, the one value that cannot fall back to something else because it
 * IS the fallback — and must forbid inventing any other.
 *
 * Two halves, gated together, because either alone is the original bug:
 * a prompt that advertises a capability the session withheld, or a session
 * that grants delegation with no contract for using it safely.
 */
import { describe, expect, it } from 'bun:test'
import { buildStudioAgentSystemPrompt } from '../../../server/ai/tools/studio/systemPrompt'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { resolveNativeToolAllowlist } from '../../../server/ai/drivers/claudeCliToolSurface'

const staticPrefix = () => buildStudioAgentSystemPrompt(null, studioAgentTools)[0]!

describe('the Studio agent subagent contract', () => {
  it('never grants Bash — the one tool the project cwd does not bound', () => {
    for (const workspaceCwd of ['/tmp/some-project', null]) {
      for (const hasAttachments of [true, false]) {
        const granted = resolveNativeToolAllowlist(workspaceCwd, hasAttachments).split(',').filter(Boolean)
        expect(granted).not.toContain('Bash')
      }
    }
  })

  it('grants Task ONLY with a real project open', () => {
    expect(resolveNativeToolAllowlist('/tmp/some-project', false).split(',')).toContain('Task')
    // No project: nothing to build in parallel, and no cwd bounding a write.
    expect(resolveNativeToolAllowlist(null, false).split(',').filter(Boolean)).not.toContain('Task')
    expect(resolveNativeToolAllowlist(null, true).split(',').filter(Boolean)).not.toContain('Task')
  })

  it('grants exactly the workspace tool set, so a new grant has to be deliberate', () => {
    const granted = resolveNativeToolAllowlist('/tmp/some-project', false).split(',')
    expect(granted).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'])
  })

  it('the prompt pins general-purpose as the only subagent_type', () => {
    expect(staticPrefix()).toContain("subagent_type is ALWAYS 'general-purpose'")
  })

  it('the prompt names no other subagent_type — an invented one is the fabrication bug', () => {
    // Any `'<name>'` following a `subagent_type` mention would be a second
    // permissible value; the roster names that caused the original failure are
    // checked explicitly because they are the ones a model has actually reached
    // for here.
    const prefix = staticPrefix()
    for (const invented of ['studio-implementer', 'screen-builder', 'screen-scout', 'style-surgeon', 'fidelity-auditor']) {
      expect(prefix).not.toContain(invented)
    }
  })

  it('the prompt states the ownership rule that makes a fan-out non-colliding', () => {
    const prefix = staticPrefix()
    expect(prefix).toContain('One agent per page')
    // The shared-file carve-out is the half that actually prevents lost work:
    // two agents editing one i18n dictionary destroy each other silently.
    expect(prefix).toContain('EVERY SHARED FILE IS YOURS ALONE')
  })

  it('the prompt no longer claims there are no subagents', () => {
    expect(staticPrefix()).not.toContain('no subagents,')
  })
})
