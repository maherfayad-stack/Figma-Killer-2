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
 * already cover and for same-rule colour pairs that fail WCAG AA contrast,
 * AND scans the screen's own `.tsx` for a diagnosed, reproduced failure
 * pattern — an agent that hits friction with a design-system component
 * silently falls back to hand-rolling it: a hand-drawn `<svg><path d="…">`
 * standing in for a real icon, a `style={{ width: 24 }}` patch instead of
 * real CSS, or a screen that imports nothing at all from the project's
 * configured design system. The scoring engine
 * (`auditStylesheetQuality`/`auditPageSourceQuality`,
 * `server/handlers/studio/qualityAudit.ts`) reuses the exact
 * `buildProjectTokenIndex`/`contrastRatio` machinery `studio_measure_
 * reference` already uses for the stylesheet half — no second colour-matching
 * or contrast implementation.
 *
 * ## Creative substance (W9-3, `STUDIO-WAVE7-PLAN.md`)
 *
 * Everything above is COMPLIANCE — "this hex should be a token". A screen can
 * satisfy all of it and still be template-y: three stacked grey boxes, one
 * type size, two of the design system's forty-two components. Two further
 * rule families grade that, and both cost nothing new (same token index, same
 * already-read files):
 *
 *   - `design-system-coverage-low`, in `auditPageSourceQuality`, graded
 *     against the SAME `DesignSystemGuide` (`resolveDesignSystemGuide`) that
 *     `projectGuide.ts` renders into this project's own `CLAUDE.md` decision
 *     table — resolved here once per call, so the finding can only ever name
 *     components the agent was actually offered.
 *   - `off-scale-spacing` / `off-scale-type-size` / `flat-type-hierarchy`, in
 *     `auditCompositionQuality` (`server/handlers/studio/compositionAudit.ts`),
 *     run ONCE per page over the page's whole
 *     stylesheet set rather than per file (a type hierarchy computed inside
 *     one `.module.css` measures a fragment) and as aggregates rather than
 *     per declaration (which would double-report every `raw-px-length`).
 *
 * A fourth `.tsx` check — flagging hand-built markup for a role the
 * generated `CLAUDE.md` decision table maps to a real component (the
 * `BottomSheet` failure in the diagnosed run) — was prototyped as a
 * word-overlap heuristic between local CSS class names and catalog component
 * names and REJECTED: against the real fixture that motivated it, it fired
 * on `backButton`/`channelText`/`codeCell`/`heroNotificationLogo` (ordinary
 * English words colliding with `Button`/`TextInput`/`Cell`/`AlmosaferLogo`)
 * roughly 20 times for the one genuine hit (`sheetHandle` vs. `BottomSheet`).
 * A noisy rule trains the agent to ignore this tool entirely, which is worse
 * than not having the rule — left out rather than shipped false-positive-prone.
 *
 * Server-resolved, headless: no editor bridge, no live capture. Reads each
 * page's `.tsx` (`resolvePageSourceFile`) to discover which `.css`/
 * `.module.css` files it (and any inlined local component) actually imports
 * (`collectPageStylesheets` — the SAME stylesheet-discovery walk
 * `studioCss.ts` uses to wire the canvas's own styling, not a second one),
 * then runs the stylesheet audit over each AND the page-source audit over the
 * `.tsx` text itself (read once, at the same resolved path — no second
 * discovery walk). This is a COMPLEMENT to `studio_screenshot`, not a
 * replacement — it cannot see what the screen looks like, only whether its
 * source follows the project's own rules.
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
import { createWorkspaceProject, parsePageFile, unresolvedRawTextImports } from '@core/page-parser'
import { collectPageStylesheets } from '@core/studio-sync/collectPageStylesheets'
import type { PageStylesheet } from '@core/studio-sync/pageStylesheet'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { compileProjectStyles } from '../../../../handlers/studio/styleCompile'
import { buildProjectTokenIndex, type ProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { auditPageSourceQuality, auditStylesheetQuality, type DesignSystemCatalog, type QualityFinding } from '../../../../handlers/studio/qualityAudit'
import { auditCompositionQuality, type PageStylesheetText } from '../../../../handlers/studio/compositionAudit'
import { resolveDesignSystemGuide } from '../../../../handlers/studio/projectGuide'
import { resolvePageSourceFile } from '../../../../handlers/studio/pageSourceFile'
import { auditFontAvailability, collectFontAvailability } from './fontAvailability'
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
    'Reference-free quality signals for one or more screens you built WITHOUT a design to measure against — studio_compare and studio_measure_reference both need a registered reference; this needs none. Statically scans each screen\'s own .css/.module.css (and any inlined local component\'s) AND its own .tsx. Stylesheet checks: raw-hex-color / raw-px-length — a literal value where the project already declares a var(--token) close enough that it is almost certainly the one you meant, so you know exactly which var() to swap in — and low-contrast-pair — a single rule that declares both color and a background whose WCAG contrast falls under the 4.5:1 AA-normal-text floor (this cannot see font-size/font-weight, so a genuinely large/bold rule may still pass WCAG AA\'s looser 3:1 large-text threshold in practice; the finding says so). Page-source checks, the ones that catch the agent hand-rolling something the design system already provides, or shipping an icon that is simply absent: unresolved-asset-import — a `?raw` import naming a file that is NOT on disk, so the element renders empty while still typechecking and still holding its box (the one finding here no screenshot and no `tsc` run will ever tell you); hand-authored-vector-path — a literal <svg> containing a hand-written <path d="..."> instead of a real icon; hardcoded-inline-sizing — style={{ width: 24 }} patching layout inline instead of in the stylesheet (does not flag the legitimate style={{ \'--x\': value }} dynamic-custom-property case, or any genuinely computed value); design-system-unused — this screen imports nothing at all from the project\'s configured design-system package(s), worth checking even though a legitimately plain screen can have zero imports; design-system-coverage-low — this screen DOES use the design system but renders fewer than 4 distinct components from it while the catalog offers 8 or more, and the finding NAMES the ones it did not take (the diagnosed failure: a shipped screen used 2 of 42 available components and hand-rolled the rest, which no other check here can see); font-not-available — the FIRST family in a font-family stack that this project cannot load (no @font-face anywhere it can see, no Google Fonts link, no next/font/google import, no matching font file on disk), so the browser silently renders the screen in a fallback face whose metrics differ and every font-size you then tune against a screenshot is tuned against the wrong typeface. Composition checks, page-wide aggregates rather than one finding per declaration, each graded ONLY against the project\'s own declared tokens (a project that declares no spacing tokens gets no spacing rule, never an invented 4px default): off-scale-spacing — how many padding/margin/gap values are not multiples of the step this project\'s own spacing tokens are built on, with each offender\'s file:line; off-scale-type-size — font-size values sitting on no step of the project\'s type scale, with the scale listed; flat-type-hierarchy — the screen\'s largest type divided by its most common (body) size is under 1.6, i.e. nothing leads and the screen reads as a list of equals. Each finding carries a file:line and a message naming the exact fix. Name screens the way you named the files ("Checkout"), or pass several at once to audit a whole flow in one call, or omit `pages` to audit every screen in the project. This complements studio_screenshot, it does not replace it — a clean audit here says nothing about whether the screen LOOKS right, only whether its source follows the project\'s own rules. Returns { results[] }, each { ok, page, findings[], findingCount, filesScanned, rulesScanned, truncated } — a page whose own source location can\'t be decoded becomes an ok:false entry rather than failing the whole call.',
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
    // Token matching AND design-system-package detection both degrade to
    // "none" on a probe failure — the audit still runs, it just cannot
    // suggest a var(--token) swap or check design-system adoption. Same
    // degrade path `studio_measure_reference` uses for tokens; extended here
    // to cover the one extra fact the page-source audit needs from the same
    // profile call, rather than resolving the profile a second time.
    let cssSources: string[] = []
    let componentPackages: string[] = []
    let catalog: DesignSystemCatalog | undefined
    try {
      const profile = resolveProjectProfile(dir)
      componentPackages = profile.componentPackages
      // The SAME guide `projectGuide.ts` renders into this project's own
      // CLAUDE.md decision table — so the coverage finding can only ever name
      // components the agent was actually offered. Resolved once per call,
      // like the token index below it; `undefined` for a project whose
      // package ships neither docs nor readable type declarations, which
      // correctly disables the coverage rule rather than inventing a catalog.
      const guide = resolveDesignSystemGuide(dir, profile)
      if (guide) catalog = { packageName: guide.packageName, componentNames: guide.components.map((c) => c.name) }
      const compiled = await compileProjectStyles(dir, profile)
      cssSources = [compiled.styles.vendorCss, compiled.styles.css]
    } catch (err) {
      console.error('[studio_quality_check] could not resolve the project profile / compile project styles:', err)
    }
    const tokens: ProjectTokenIndex = buildProjectTokenIndex(...cssSources)
    // Workspace-level, like the token index above: a font-file disk walk and
    // the project's setup files are the same facts for every page in the
    // batch. See `fontAvailability.ts` for what counts as available.
    const fonts = collectFontAvailability(dir, cssSources)

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

      const absPageFile = join(dir, ...relFile.split('/'))
      const parsed = parsePageFile(absPageFile, dir, project, { workspaceRoot: dir })
      const sheets: PageStylesheet[] = collectPageStylesheets(parsed, relFile, project, dir)

      const filesScanned: string[] = []
      const findings: QualityFinding[] = []
      let rulesScanned = 0
      let truncated = false

      // Page source (.tsx) — hand-authored vectors, hardcoded inline sizing,
      // design-system adoption. Runs regardless of whether the page has a
      // stylesheet: a page with zero CSS to audit can still have all three.
      try {
        const pageText = readFileSync(absPageFile, 'utf8')
        filesScanned.push(relFile)
        // Asked of the SAME ts-morph `Project` the parse above used, so the
        // "this file is not on disk" finding reports exactly what the
        // evaluator failed to resolve rather than re-deriving module
        // resolution a second, drifting way.
        const sourceFile = project.getSourceFile(absPageFile)
        const deadImports = sourceFile ? unresolvedRawTextImports(sourceFile, dir) : []
        const pageResult = auditPageSourceQuality(pageText, relFile, componentPackages, deadImports, catalog)
        rulesScanned += pageResult.rulesScanned
        findings.push(...pageResult.findings)
        if (pageResult.truncated) truncated = true
      } catch (err) {
        console.error(`[studio_quality_check] could not read ${relFile}:`, err)
      }

      if (sheets.length === 0) {
        const bounded = findings.slice(0, MAX_FINDINGS_PER_PAGE)
        results.push({
          ok: true,
          page: { id: match.id, title: match.title },
          filesScanned,
          rulesScanned,
          findings: bounded,
          findingCount: bounded.length,
          truncated: truncated || findings.length > MAX_FINDINGS_PER_PAGE,
          note: `"${match.title}" (or its inlined local components) imports no .css/.module.css file — nothing there to audit for token/contrast issues. If it should have a stylesheet, that is itself worth a note: "Real styling belongs in the stylesheet" from the system prompt.`,
        })
        continue
      }

      findings.push(...auditFontAvailability(sheets, fonts))

      const sheetTexts: PageStylesheetText[] = []
      for (const sheet of sheets) {
        let text: string
        try {
          text = readFileSync(sheet.absPath, 'utf8')
        } catch (err) {
          console.error(`[studio_quality_check] could not read ${sheet.relPath}:`, err)
          continue
        }
        sheetTexts.push({ relFile: sheet.relPath, cssText: text })
        if (findings.length >= MAX_FINDINGS_PER_PAGE) {
          truncated = true
          continue
        }
        const result = auditStylesheetQuality(text, sheet.relPath, tokens)
        rulesScanned += result.rulesScanned
        findings.push(...result.findings)
        if (result.truncated) truncated = true
      }

      // Composition runs over the page's WHOLE stylesheet set, not per file:
      // a screen's type scale lives across every sheet it imports, so a
      // per-file "largest / body" ratio measures a fragment. At most three
      // findings — see `auditCompositionQuality`'s doc.
      const composition = auditCompositionQuality(sheetTexts, tokens)
      rulesScanned += composition.rulesScanned
      findings.push(...composition.findings)

      const bounded = findings.slice(0, MAX_FINDINGS_PER_PAGE)
      truncated = truncated || findings.length > MAX_FINDINGS_PER_PAGE

      results.push({
        ok: true,
        page: { id: match.id, title: match.title },
        filesScanned: [...filesScanned, ...sheets.map((s) => s.relPath)],
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
