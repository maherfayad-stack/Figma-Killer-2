/**
 * Architecture Gate — the agent is told HOW to design, on both paths, and is
 * told no other project's facts (audit 06, AI-19; P4-D).
 *
 * ## Why a deterministic gate stands in for a paid turn
 *
 * Whether a model designs better is measured by a bench turn (`bench:agent-turn`,
 * the Phase 4 exit gate), which costs money and cannot run in CI. What CAN be
 * held without a model is that the guidance reaches it: every section the
 * rewrite exists for is in the text each path actually sends — the file the
 * `claude` CLI is handed through `--append-system-prompt-file`, and the system
 * text an HTTP driver puts on the wire (Anthropic's cached system block, the
 * OpenAI-compatible `role:'system'` message). A prompt builder that returned
 * the right string while one path sent something else is exactly the failure
 * AI-1 was.
 *
 * ## What it holds
 *
 *   - **Mode first.** "What done means" comes before the workflow and sends
 *     the model to the Fidelity block — the old prompt stated a reproduction
 *     rule as non-negotiable ~9 KB before the creative block redefined done.
 *   - **The craft sections**: decide before drawing, real content, one
 *     critique pass, the craft rubric (hierarchy, rhythm, alignment, type,
 *     colour, touch targets, states), initiative, and the static-composition
 *     rule P4-B moved out of the generated CLAUDE.md.
 *   - **No project facts.** The prompt stated one eSIM project's Button size
 *     mapping and its CTA hex as if true of every project (AI-19). A fact about
 *     a project belongs in that project's generated guide; stated here it is
 *     false everywhere else and biases every turn.
 *   - **A size budget.** See {@link STATIC_PREFIX_BUDGET_CHARS}.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_CAPABILITIES, type CoreCapability } from '../../core/capabilities'
import { buildStudioProjectSystemPrompt } from '../../../server/ai/chatSystemPrompt'
import { buildStudioAgentSystemPrompt, type StudioPromptContext } from '../../../server/ai/tools/studio/systemPrompt'
import { selectStudioTools } from '../../../server/ai/tools'
import { MODE_BLOCK } from '../../../server/ai/tools/studio/promptSessionBlocks'
import { FIDELITY_MODES } from '../../../server/handlers/studio/fidelityMode'
import { DESIGN_POLICIES } from '../../../server/handlers/studio/designPolicy'
import { runClaudeCliTurns } from '../../../server/ai/drivers/claudeCli.testHelpers'
import { buildSystemBlocks } from '../../../server/ai/drivers/anthropic'
import { mapChatHistory } from '../../../server/ai/drivers/http/chatCompletions'

/**
 * The static prefix (role, workflow, rubric, failures, mode block, policy
 * block) for every path x mode x policy, in characters.
 *
 * 34,000 chars is about 8.5K tokens. Before this rewrite the largest prefix
 * was ~36.9K (CLI, creative, follow); P4-B made the CLI carry all of it,
 * about 9K tokens more per CLI session. The rewrite adds the rubric and the
 * craft steps and still comes in at ~32.5K, so the budget is set UNDER the
 * old size with ~1.5K of headroom: the craft guidance is paid for by what it
 * replaced, and any later growth is a deliberate edit to this number rather
 * than a drift nobody decided. The prefix is prompt-cached per (mode, policy)
 * on both paths, so this is a per-cache-window cost, not per turn — but a
 * smaller model still reads every character of it.
 */
const STATIC_PREFIX_BUDGET_CHARS = 34_000

/** Sections the rewrite exists for, each named by text that only that section carries. */
const CRAFT_SECTIONS = [
  '# What "done" means — read the Fidelity block at the end of this prompt FIRST',
  'DECIDE BEFORE YOU DRAW',
  'WRITE REAL CONTENT',
  'LOOK, THEN CRITIQUE ONCE',
  '# Craft rubric',
  'Hierarchy:',
  'Rhythm:',
  'Alignment:',
  'Type:',
  'Colour:',
  'Touch and mobile: targets at least 44x44 px',
  'States:',
  '# Initiative',
  'SCREEN FILE IS A STATIC COMPOSITION',
]

/** One project's facts, formerly stated as universal (AI-19), and example ids from that project. */
const PROJECT_FACTS = [
  'ef4550',
  'coral',
  'type-subtitle-size',
  "size=\"default\" resolves",
  'Open Sans',
  'eSIM',
  'AddMobile',
  'VerifyEmail',
  "pageId:'sms'",
  'in this project',
  'on this project',
  'On this project',
]

const ALL = [...CORE_CAPABILITIES] as CoreCapability[]
const cliTools = selectStudioTools(ALL, { studioProjectOpen: true })
const httpTools = selectStudioTools(ALL, { studioProjectOpen: true, fileAccess: 'studio-tools' })

function expectCraftedPrompt(text: string, label: string): void {
  for (const section of CRAFT_SECTIONS) expect(text, `${label} is missing "${section}"`).toContain(section)
  for (const fact of PROJECT_FACTS) expect(text.toLowerCase(), `${label} states a project fact: "${fact}"`).not.toContain(fact.toLowerCase())
  // Mode first: the definition of done, and its pointer to the mode block,
  // come before the workflow that acts on it.
  expect(text.indexOf('# What "done" means'), `${label}: "done" must precede the workflow`).toBeLessThan(text.indexOf('# Workflow'))
  expect(text.indexOf('# Workflow')).toBeGreaterThan(-1)
}

describe('the craft prompt reaches the claude CLI (the file it is handed)', () => {
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

  for (const mode of FIDELITY_MODES) {
    it(`${mode}: every craft section, the mode block, no project facts`, async () => {
      const { turns } = await runClaudeCliTurns([buildStudioAgentSystemPrompt(CTX, cliTools, null, mode, 'balanced')], { warm: true })
      const appended = turns[0]!.appendedSystemPrompt!
      expectCraftedPrompt(appended, `CLI/${mode}`)
      expect(appended).toContain(MODE_BLOCK[mode].trim())
    })
  }
})

describe('the craft prompt reaches the HTTP drivers (the system text on the wire)', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-prompt-craft-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const mode of FIDELITY_MODES) {
    it(`${mode}: Anthropic's system blocks and the chat/completions system message`, async () => {
      const systemPrompt = await buildStudioProjectSystemPrompt(dir, null, `craft-${mode}`, httpTools, undefined, undefined, mode, 'balanced')
      const blocks = buildSystemBlocks(systemPrompt)
      const anthropicText = typeof blocks === 'string' ? blocks : blocks.map((block) => block.text).join('\n\n')
      const [[system]] = mapChatHistory(systemPrompt, []) as unknown as [[{ role: string; content: string }]]
      expect(system.role).toBe('system')
      for (const [wire, text] of [['anthropic', anthropicText], ['chat/completions', system.content]] as const) {
        expectCraftedPrompt(text, `HTTP ${wire}/${mode}`)
        expect(text).toContain(MODE_BLOCK[mode].trim())
      }
    })
  }
})

describe('the static prefix stays inside its budget', () => {
  it(`every path x mode x policy is at most ${STATIC_PREFIX_BUDGET_CHARS.toLocaleString('en-US')} characters`, () => {
    for (const [path, tools] of [['cli', cliTools], ['http', httpTools]] as const) {
      for (const mode of FIDELITY_MODES) {
        for (const policy of DESIGN_POLICIES) {
          const [prefix] = buildStudioAgentSystemPrompt(null, tools, null, mode, policy)
          expect(prefix!.length, `${path}/${mode}/${policy}`).toBeLessThanOrEqual(STATIC_PREFIX_BUDGET_CHARS)
        }
      }
    }
  })
})
