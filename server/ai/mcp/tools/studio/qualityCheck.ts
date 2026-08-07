/**
 * `studio_quality_check` — A3 (STUDIO-FIGMA-PARITY-PLAN.md): reference-free
 * quality signals for a from-scratch brief.
 *
 * `studio_compare` and `studio_measure_reference` both need a registered
 * design reference. On a from-scratch screen — no pasted comp, no Figma
 * connector — neither has anything to measure against, so the agent's only
 * signal was `studio_screenshot` plus its own subjective judgement of a
 * picture. This closes part of that gap: it statically scans the screen's OWN
 * already-written stylesheet(s) for one-off values the project's own tokens
 * already cover, and for same-rule colour pairs that fail WCAG AA contrast.
 * The scoring engine (`auditStylesheetQuality`,
 * `server/handlers/studio/qualityAudit.ts`) reuses the exact
 * `buildProjectTokenIndex`/`contrastRatio` machinery `studio_measure_
 * reference` already uses — no second colour-matching or contrast
 * implementation.
 *
 * Server-resolved, headless: no editor bridge, no live capture. Reads the
 * page's `.tsx` (`resolvePageSourceFile`) to discover which `.css`/
 * `.module.css` files it (and any inlined local component) actually imports
 * (`collectPageStylesheets` — the SAME stylesheet-discovery walk
 * `studioCss.ts` uses to wire the canvas's own styling, not a second one),
 * then runs the audit over each. This is a COMPLEMENT to `studio_screenshot`,
 * not a replacement — it cannot see what the screen looks like, only whether
 * its stylesheet follows the project's own rules.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError } from '@core/ai'
import { createWorkspaceProject, parsePageFile } from '@core/page-parser'
import { collectPageStylesheets, type PageStylesheet } from '@core/studio-sync/collectPageStylesheets'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { compileProjectStyles } from '../../../../handlers/studio/styleCompile'
import { buildProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { auditStylesheetQuality, type QualityFinding } from '../../../../handlers/studio/qualityAudit'
import { resolvePageSourceFile } from '../../../../handlers/studio/pageSourceFile'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolvePageByName } from './pageNameMatch'

/** Bounds the response the same way every other Studio tool caps a payload — far above any real screen's own finding count. */
const MAX_FINDINGS_RETURNED = 60

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    page: Type.String({
      minLength: 1,
      description: 'The screen to audit, named the way you named the file — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work.',
    }),
  },
  { additionalProperties: false },
)

export const studioQualityCheckTool: AiTool = {
  name: 'studio_quality_check',
  scope: 'shared',
  execution: 'server',
  description:
    'Reference-free quality signals for a screen you built WITHOUT a design to measure against — studio_compare and studio_measure_reference both need a registered reference; this needs none. Statically scans the screen\'s own .css/.module.css (and any inlined local component\'s) for two things: raw-hex-color / raw-px-length — a literal value where the project already declares a var(--token) close enough that it is almost certainly the one you meant, so you know exactly which var() to swap in — and low-contrast-pair — a single rule that declares both color and a background whose WCAG contrast falls under the 4.5:1 AA-normal-text floor (this cannot see font-size/font-weight, so a genuinely large/bold rule may still pass WCAG AA\'s looser 3:1 large-text threshold in practice; the finding says so). Each finding carries a file:line and a message naming the exact fix. This complements studio_screenshot, it does not replace it — a clean audit here says nothing about whether the screen LOOKS right, only whether its stylesheet follows the project\'s own rules. Returns { findings[], findingCount, filesScanned, rulesScanned, truncated }.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, page } = input as { dir?: string; page: string }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const { pages } = await loadStudioPages(dir)
    const match = resolvePageByName(pages, page)
    if (!match) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return aiToolError(`No screen matched "${page}". This project has: ${known}.`)
    }

    const relFile = resolvePageSourceFile(match)
    if (!relFile) {
      return aiToolError(`Could not determine "${match.title}"'s own source file to audit — its nodes carry no decodable source location.`)
    }

    const project = createWorkspaceProject(dir)
    const parsed = parsePageFile(join(dir, ...relFile.split('/')), dir, project, { workspaceRoot: dir })
    const sheets: PageStylesheet[] = collectPageStylesheets(parsed, relFile, project, dir)
    if (sheets.length === 0) {
      return {
        ok: true,
        page: { id: match.id, title: match.title },
        filesScanned: [],
        rulesScanned: 0,
        findings: [],
        findingCount: 0,
        truncated: false,
        note: `"${match.title}" (or its inlined local components) imports no .css/.module.css file — nothing to audit. If it should have a stylesheet, that is itself the finding: "Real styling belongs in the stylesheet" from the system prompt.`,
      }
    }

    // Token matching degrades to "no tokens" on a probe failure — the audit
    // still runs and still catches contrast, it just cannot suggest a
    // var(--token) swap. Same degrade path `studio_measure_reference` uses.
    let cssSources: string[] = []
    try {
      const compiled = await compileProjectStyles(dir, resolveProjectProfile(dir))
      cssSources = [compiled.styles.vendorCss, compiled.styles.css]
    } catch (err) {
      console.error('[studio_quality_check] could not compile project styles for token matching:', err)
    }
    const tokens = buildProjectTokenIndex(...cssSources)

    const findings: QualityFinding[] = []
    let rulesScanned = 0
    let truncated = false
    for (const sheet of sheets) {
      if (findings.length >= MAX_FINDINGS_RETURNED) {
        truncated = true
        break
      }
      let text: string
      try {
        text = readFileSync(sheet.absPath, 'utf8')
      } catch (err) {
        console.error(`[studio_quality_check] could not read ${sheet.relPath}:`, err)
        continue
      }
      const result = auditStylesheetQuality(text, sheet.relPath, tokens)
      rulesScanned += result.rulesScanned
      findings.push(...result.findings)
      if (result.truncated) truncated = true
    }

    const bounded = findings.slice(0, MAX_FINDINGS_RETURNED)
    truncated = truncated || findings.length > MAX_FINDINGS_RETURNED

    return {
      ok: true,
      page: { id: match.id, title: match.title },
      filesScanned: sheets.map((s) => s.relPath),
      rulesScanned,
      findings: bounded,
      findingCount: bounded.length,
      truncated,
      tokensIndexed: { colorCount: tokens.colors.length, sizeCount: tokens.fontSizes.length + tokens.lengths.length },
    }
  },
}

export const studioQualityCheckMcpTools: AiTool[] = [studioQualityCheckTool]
