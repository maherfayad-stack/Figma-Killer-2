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
 * Server-resolved, headless: no editor bridge, no live capture. Reads each
 * page's `.tsx` (`resolvePageSourceFile`) to discover which `.css`/
 * `.module.css` files it (and any inlined local component) actually imports
 * (`collectPageStylesheets` — the SAME stylesheet-discovery walk
 * `studioCss.ts` uses to wire the canvas's own styling, not a second one),
 * then runs the audit over each. This is a COMPLEMENT to `studio_screenshot`,
 * not a replacement — it cannot see what the screen looks like, only whether
 * its stylesheet follows the project's own rules.
 *
 * ## Batching (mcp-tooling CHANGE A)
 *
 * Takes `pages`, not `page` — the same name-resolved, optional, capped array
 * `studio_screenshot`/`studio_compare` use (`resolveRequestedPages`,
 * `MAX_BATCH_PAGES` in `pageNameMatch.ts`). Being headless and reference-free,
 * this tool has no per-page failure mode `studio_compare` has to guard against
 * (no bridge, no reference to miss) — the one per-page failure that remains
 * is "this page's own source location can't be decoded", which still becomes
 * a `results[]` entry with `ok:false` rather than failing the whole batch.
 *
 * Project-wide setup — the token index (`buildProjectTokenIndex`) and the
 * shared ts-morph `Project` (`createWorkspaceProject`) — is built exactly
 * ONCE per call and reused for every page, the same split `screenshot.ts`
 * uses for its own `canonicalProject`: these are workspace-level facts, not
 * per-page ones, and recomputing them per page in a batch would be pure
 * waste (a `compileProjectStyles` run and a fresh ts-morph `Project` PER
 * screen, for something identical across all of them).
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
import { buildProjectTokenIndex, type ProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { auditStylesheetQuality, type QualityFinding } from '../../../../handlers/studio/qualityAudit'
import { resolvePageSourceFile } from '../../../../handlers/studio/pageSourceFile'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { MAX_BATCH_PAGES, resolveRequestedPages } from './pageNameMatch'

/** Bounds the response the same way every other Studio tool caps a payload — far above any real screen's own finding count. Applied PER PAGE, not per call — a five-screen batch legitimately needs up to 5x this. */
const MAX_FINDINGS_PER_PAGE = 60

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    pages: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_BATCH_PAGES,
        description:
          'Which screens to audit, by name — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work. Omit to audit every screen in the project (up to 20) in one call.',
      }),
    ),
  },
  { additionalProperties: false },
)

interface PageQualityResult {
  ok: boolean
  page: { id: string; title: string }
  filesScanned: string[]
  rulesScanned: number
  findings: QualityFinding[]
  findingCount: number
  truncated: boolean
  note?: string
  error?: string
}

export const studioQualityCheckTool: AiTool = {
  name: 'studio_quality_check',
  scope: 'shared',
  execution: 'server',
  description:
    'Reference-free quality signals for one or more screens you built WITHOUT a design to measure against — studio_compare and studio_measure_reference both need a registered reference; this needs none. Statically scans each screen\'s own .css/.module.css (and any inlined local component\'s) for two things: raw-hex-color / raw-px-length — a literal value where the project already declares a var(--token) close enough that it is almost certainly the one you meant, so you know exactly which var() to swap in — and low-contrast-pair — a single rule that declares both color and a background whose WCAG contrast falls under the 4.5:1 AA-normal-text floor (this cannot see font-size/font-weight, so a genuinely large/bold rule may still pass WCAG AA\'s looser 3:1 large-text threshold in practice; the finding says so). Each finding carries a file:line and a message naming the exact fix. Name screens the way you named the files ("Checkout"), or pass several at once to audit a whole flow in one call, or omit `pages` to audit every screen in the project. This complements studio_screenshot, it does not replace it — a clean audit here says nothing about whether the screen LOOKS right, only whether its stylesheet follows the project\'s own rules. Returns { results[] }, each { ok, page, findings[], findingCount, filesScanned, rulesScanned, truncated } — a page whose own source location can\'t be decoded becomes an ok:false entry rather than failing the whole call.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pages: requested } = input as { dir?: string; pages?: string[] }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const { pages } = await loadStudioPages(dir)
    const { ids, unmatched } = resolveRequestedPages(pages, requested, MAX_BATCH_PAGES)
    if (ids.length === 0) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return aiToolError(
        unmatched.length > 0
          ? `No screen matched ${unmatched.map((n) => `"${n}"`).join(', ')}. This project has: ${known}.`
          : `This project has no screens to audit yet.`,
      )
    }

    const pageById = new Map(pages.map((p) => [p.id, p]))

    // Built ONCE for the whole batch and reused per page — see module doc.
    const project = createWorkspaceProject(dir)
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
    const tokens: ProjectTokenIndex = buildProjectTokenIndex(...cssSources)

    const results: PageQualityResult[] = []
    for (const pageId of ids) {
      const match = pageById.get(pageId)!
      const relFile = resolvePageSourceFile(match)
      if (!relFile) {
        results.push({
          ok: false,
          page: { id: match.id, title: match.title },
          filesScanned: [],
          rulesScanned: 0,
          findings: [],
          findingCount: 0,
          truncated: false,
          error: `Could not determine "${match.title}"'s own source file to audit — its nodes carry no decodable source location.`,
        })
        continue
      }

      const parsed = parsePageFile(join(dir, ...relFile.split('/')), dir, project, { workspaceRoot: dir })
      const sheets: PageStylesheet[] = collectPageStylesheets(parsed, relFile, project, dir)
      if (sheets.length === 0) {
        results.push({
          ok: true,
          page: { id: match.id, title: match.title },
          filesScanned: [],
          rulesScanned: 0,
          findings: [],
          findingCount: 0,
          truncated: false,
          note: `"${match.title}" (or its inlined local components) imports no .css/.module.css file — nothing to audit. If it should have a stylesheet, that is itself the finding: "Real styling belongs in the stylesheet" from the system prompt.`,
        })
        continue
      }

      const findings: QualityFinding[] = []
      let rulesScanned = 0
      let truncated = false
      for (const sheet of sheets) {
        if (findings.length >= MAX_FINDINGS_PER_PAGE) {
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

      const bounded = findings.slice(0, MAX_FINDINGS_PER_PAGE)
      truncated = truncated || findings.length > MAX_FINDINGS_PER_PAGE

      results.push({
        ok: true,
        page: { id: match.id, title: match.title },
        filesScanned: sheets.map((s) => s.relPath),
        rulesScanned,
        findings: bounded,
        findingCount: bounded.length,
        truncated,
      })
    }

    return {
      ok: true,
      dir,
      results,
      ...(unmatched.length > 0 ? { unmatched } : {}),
      tokensIndexed: { colorCount: tokens.colors.length, sizeCount: tokens.fontSizes.length + tokens.lengths.length },
    }
  },
}

export const studioQualityCheckMcpTools: AiTool[] = [studioQualityCheckTool]
