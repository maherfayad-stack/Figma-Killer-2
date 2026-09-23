/**
 * Architecture Gate — the Claude CLI agent receives the fidelity mode, the
 * design policy, and the rest of Studio's prompt (audit 06, AI-1).
 *
 * ## The failure this exists to prevent
 *
 * The CLI is the DEFAULT agent path. For months it received only the dynamic
 * suffix of Studio's system prompt: never the static prefix, never
 * `MODE_BLOCK`, never `DESIGN_POLICY_BLOCK`. The mode and policy controls were
 * declared done and gated, but the gates asserted the string a prompt BUILDER
 * returned, which only the HTTP path ever sent. On the default path, choosing
 * "free" or "creative" changed nothing but the graders, and the generated
 * `CLAUDE.md` told the agent the opposite ("always use the design system").
 *
 * So this gate asserts what the CLI process is actually GIVEN: it runs real
 * `streamClaudeCli` turns against a fake binary, reads the
 * `--append-system-prompt-file` file named on the spawned argv, and checks
 * every (mode, policy) pair on both the warm path (the production default) and
 * the cold path (crash recovery).
 */
import { describe, expect, it } from 'bun:test'
import { buildStudioAgentSystemPrompt, type StudioPromptContext } from '../../../server/ai/tools/studio/systemPrompt'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { DESIGN_POLICY_BLOCK, MODE_BLOCK } from '../../../server/ai/tools/studio/promptSessionBlocks'
import { FIDELITY_MODES } from '../../../server/handlers/studio/fidelityMode'
import { DESIGN_POLICIES } from '../../../server/handlers/studio/designPolicy'
import { runClaudeCliTurns } from '../../../server/ai/drivers/claudeCli.testHelpers'

const CTX: StudioPromptContext = {
  dir: 'capture-project',
  name: 'Capture',
  trust: 'static',
  framework: 'vite',
  pagesDir: 'pages',
  packageManager: 'bun',
  styleToolchain: { tailwind: false, sass: false, cssModules: true },
  componentPackages: [],
  warningCount: 0,
}

/** The first line of a block — its `# Fidelity: …` / `# Design policy: …` heading. */
const heading = (block: string): string => block.trim().split('\n')[0]!

for (const path of ['warm', 'cold'] as const) {
  describe(`the CLI receives the mode and policy blocks (${path} path)`, () => {
    for (const mode of FIDELITY_MODES) {
      for (const policy of DESIGN_POLICIES) {
        it(`${mode} / ${policy}`, async () => {
          const systemPrompt = buildStudioAgentSystemPrompt(CTX, studioAgentTools, null, mode, policy)
          const { turns } = await runClaudeCliTurns([systemPrompt], { warm: path === 'warm' })
          const turn = turns[0]!
          expect(turn.argv.filter((arg) => arg === '--append-system-prompt-file')).toHaveLength(1)
          const appended = turn.appendedSystemPrompt!

          // The whole block, verbatim — not just a heading that could survive
          // a truncated or re-worded body.
          expect(appended).toContain(MODE_BLOCK[mode].trim())
          expect(appended).toContain(DESIGN_POLICY_BLOCK[policy].trim())
          for (const other of FIDELITY_MODES.filter((m) => m !== mode)) {
            expect(appended).not.toContain(heading(MODE_BLOCK[other]))
          }
          for (const other of DESIGN_POLICIES.filter((p) => p !== policy)) {
            expect(appended).not.toContain(heading(DESIGN_POLICY_BLOCK[other]))
          }

          // The static prefix travels with them, and the live state after it.
          expect(appended).toContain('# Required workflow')
          expect(appended).toContain('# Parallel work')
          expect(appended.indexOf('Project: "Capture"')).toBeGreaterThan(appended.indexOf(heading(DESIGN_POLICY_BLOCK[policy])))
        })
      }
    }
  })
}
