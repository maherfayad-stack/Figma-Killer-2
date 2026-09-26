/**
 * Architecture Gate — a Tier-2 Studio tool is reachable, and is gated twice.
 *
 * ## The two failures this holds shut, which pull in opposite directions
 *
 * **1. Unreachable.** `studio_render_reference` is the only tool in the whole
 * Studio surface that validates a screen against the project ACTUALLY
 * RUNNING, rather than against Studio's static parse. It requires
 * `studio.run.project`, and that capability used to be withheld from the
 * built-in Admin role — the role every real operator has. So the tool was
 * filtered out of `selectStudioTools` for everybody, silently, while the
 * prompt's own tool list still described it. "Done" could only ever be
 * checked against the parse. A10 grants the capability to Admin.
 *
 * **2. Weaker than the route.** Granting the capability is only safe because
 * it is no longer the whole gate. `sec-05` finding 1: the MCP tool checked
 * the connector capability and nothing else, while the HTTP route performing
 * the identical spawn (`/admin/api/studio/dev-server`) demanded the target
 * project's own `.studio/meta.json` trust tier be exactly `run-project`. A
 * connector could therefore run a project its owner had never promoted. An
 * MCP caller must never be able to invoke something the granting
 * capabilities couldn't authorize over HTTP.
 *
 * Together: "this operator may run project code" × "this project is at Tier
 * 2". This gate asserts BOTH halves are still present, because deleting
 * either one restores one of the two failures above.
 *
 * **What the second half is worth** (`sec-12`, and read this before leaning on
 * it): it proves the project's tier, and every project starts at `run-project`
 * by default (`DEFAULT_TRUST_TIER` — owner decision, 2026-09-20) — so it is
 * not per-call human consent, it is the product default. It is only a gate at
 * all because the agent cannot write `.studio/` itself
 * (`server/handlers/studio/agentWriteScope.ts`); without that refusal the
 * caller could set the field this gate reads.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_ROLES } from '../../../server/auth/capabilities'
import { selectStudioTools } from '../../../server/ai/tools'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { referenceRenderTool } from '../../../server/ai/mcp/tools/studio/referenceRender'
import { agentWriteRefusal } from '../../../server/handlers/studio/agentWriteScope'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/** Every tool declaring `studio.run.project` — the Tier-2 family this gate covers. */
const tier2Tools = studioAgentTools.filter((t) => t.requiredCapabilities?.includes('studio.run.project'))

describe('Tier-2 Studio tools — gate 1: the capability', () => {
  it('the Admin role holds studio.run.project', () => {
    const admin = SYSTEM_ROLES.find((r) => r.id === 'admin')!
    expect(admin.capabilities).toContain('studio.run.project')
  })

  it('an Admin is actually offered studio_render_reference for a Studio turn', () => {
    const admin = SYSTEM_ROLES.find((r) => r.id === 'admin')!
    const offered = selectStudioTools(admin.capabilities, { studioProjectOpen: true }).map((t) => t.name)
    expect(offered).toContain('studio_render_reference')
  })

  it('a caller WITHOUT studio.run.project is still not offered it', () => {
    // The capability remains a real gate — granting it to Admin must not have
    // turned it into decoration.
    const offered = selectStudioTools(['ai.chat', 'ai.tools.write', 'studio.write'], { studioProjectOpen: true })
    expect(offered.map((t) => t.name)).not.toContain('studio_render_reference')
  })

  it('at least one tool still declares the capability — it has not been dropped from every tool', () => {
    expect(tier2Tools.length).toBeGreaterThan(0)
    expect(referenceRenderTool.requiredCapabilities).toContain('studio.run.project')
  })
})

describe('Tier-2 Studio tools — gate 2: the project\'s own trust tier', () => {
  it('every tool declaring studio.run.project also checks the project tier', () => {
    // Source-level, deliberately: the behavioural assertion lives in each
    // tool's own test (`referenceRender.test.ts`), but a NEW Tier-2 tool that
    // forgets the second gate has no test of its own to fail. This catches it
    // on the day it is added.
    const sources: Record<string, string> = {
      studio_render_reference: readFileSync(
        join(REPO_ROOT, 'server', 'ai', 'mcp', 'tools', 'studio', 'referenceRender.ts'),
        'utf8',
      ),
      // AI-21 — ESLint loads the project's config and plugins: project code.
      studio_lint: readFileSync(join(REPO_ROOT, 'server', 'ai', 'mcp', 'tools', 'studio', 'lintTool.ts'), 'utf8'),
    }
    for (const tool of tier2Tools) {
      const source = sources[tool.name]
      expect(
        source,
        `${tool.name} requires studio.run.project but this gate does not know where its source lives — add it to the map above along with its checkTrustTier call.`,
      ).toBeDefined()
      expect(source!, `${tool.name} must call checkTrustTier(dir, 'run-project')`).toContain('checkTrustTier')
      expect(source!).toContain("'run-project'")
    }
  })

  it('the agent cannot write the file that gate into existence', () => {
    // The tier is read off `.studio/meta.json`, which sits inside the very
    // directory the CLI driver's native Write/Edit is allowed to write. If
    // that stops being refused, gate 2 is a field its own caller can set and
    // this whole describe block is decoration.
    const project = join(REPO_ROOT, 'studio-workspace', 'any-project')
    expect(agentWriteRefusal(join(project, '.studio', 'meta.json'), project)).not.toBeNull()
    expect(agentWriteRefusal(join(project, 'src', 'Home.tsx'), project)).toBeNull()
  })

  it('the tool description tells the caller about BOTH gates', () => {
    // A weaker model only ever sees the description. A refusal it was not
    // warned about reads as a broken tool and gets retried.
    for (const tool of tier2Tools) {
      expect(tool.description, tool.name).toContain('studio.run.project')
      expect(tool.description, tool.name).toContain('trust-tier-required')
    }
  })

  it('studio_lint is one of the Tier-2 tools (AI-21)', () => {
    expect(tier2Tools.map((t) => t.name)).toContain('studio_lint')
  })
})
