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
import { toolRefusal } from '@core/ai'
import { createWorkspaceProject, parsePageFile, unresolvedRawTextImports } from '@core/page-parser'
import { collectPageStylesheets } from '@core/studio-sync/collectPageStylesheets'
import type { PageStylesheet } from '@core/studio-sync/pageStylesheet'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { buildProjectTokenIndex, type ProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { collectProjectTokenCss } from '../../../../handlers/studio/projectTokenSources'
import { auditPageSourceQuality, auditStylesheetQuality, type DesignSystemCatalog, type QualityFinding } from '../../../../handlers/studio/qualityAudit'
import { findingSeverity, describeDesignPolicy, type DesignPolicy } from '../../../../handlers/studio/designPolicy'
import { resolveProjectDesignPolicy } from '../../../../handlers/studio/projectDesignPolicy'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import { recordPassingQualityCheck } from '../../../../handlers/studio/pageVerificationStore'
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
    designPolicy: Type.Optional(
      Type.Union(
        [Type.Literal('follow'), Type.Literal('balanced'), Type.Literal('free')],
        {
          description:
            'How much of this project’s own design system to hold the screen to, which decides which findings are errors. "follow" — tokens and the project’s own components only: raw-hex-color, raw-px-length, off-scale-spacing, off-scale-type-size, design-system-unused and design-system-coverage-low are ERRORS. "balanced" — the same findings as warnings, so a one-off value is allowed when you say why. "free" — those findings are not produced at all, and the screen is judged on composition and correctness instead. Contrast, a missing font, an unresolved asset import, a hand-drawn path and every composition rule are errors at EVERY policy and no policy turns them off. Omit this: the policy is resolved for you from this session and the project default. Pass it only to audit one call differently on purpose, and never to make a failing screen pass.',
        },
      ),
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
  /** A12 — how many of `findings` are at ERROR severity under the resolved policy. This is the number that decides whether the page counts as clean; `findingCount` includes warnings. */
  errorCount?: number
  truncated: boolean
  note?: string
  error?: string
}

/** A page with zero ERROR-severity findings has passed; warnings do not block. Recorded for the CREATIVE Stop gate — see `pageVerificationStore.ts`'s `recordPassingQualityCheck`. */
function recordCleanRun(
  dir: string,
  userKey: string,
  pageId: string,
  findingCount: number,
  errorCount: number,
  policy: DesignPolicy,
): void {
  if (errorCount > 0) return
  recordPassingQualityCheck(dir, userKey, pageId, findingCount, policy)
}

/**
 * A12 — drop the findings this policy turns off, and stamp a severity on the
 * rest.
 *
 * Dropped, not returned-and-marked: a `free` turn that got back eleven
 * `raw-hex-color` findings labelled "ignore me" would read as a failing audit
 * to any model skimming a list, and the next thing it does is stop trusting
 * the tool. `findingSeverity` is the single source for the split, shared with
 * the Stop gate.
 */
function applyDesignPolicy(findings: readonly QualityFinding[], policy: DesignPolicy): QualityFinding[] {
  const graded: QualityFinding[] = []
  for (const finding of findings) {
    const severity = findingSeverity(finding.code, policy)
    if (severity === 'off') continue
    graded.push({ ...finding, severity })
  }
  return graded
}

export const studioQualityCheckTool: AiTool = {
  name: 'studio_quality_check',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Reference-free source checks for screens built WITHOUT a design (studio_compare needs one). Scans each screen\'s .tsx and its own stylesheets. Findings: raw-hex-color / raw-px-length (a project token is close enough — use that var()), low-contrast-pair (under 4.5:1), unresolved-asset-import (a ?raw file not on disk), hand-authored-vector-path, hardcoded-inline-sizing, design-system-unused, design-system-coverage-low (names the components not used), font-not-available, and — graded only against the project\'s own tokens — off-scale-spacing, off-scale-type-size, flat-type-hierarchy (largest size under 1.6x body). Each has file:line and the exact fix. Pass pages as named files, or omit for every screen. Returns { results[]: { ok, page, findings[], findingCount, filesScanned, rulesScanned, truncated } }. A clean audit says nothing about how the screen LOOKS; use studio_screenshot for that.',
  inputSchema: InputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, pages: requested, designPolicy: policyArg } = input as { dir?: string; pages?: string[]; designPolicy?: DesignPolicy }
    const dir = resolveToolProjectDir(dirInput, ctx)

    // A12 — resolved ONCE per call: the tool argument (a caller who names a
    // policy means that policy), then this turn's resolved policy from the
    // chat handler, then the project's persisted default, then `balanced`.
    // Same chain the prompt block was built from, so the grader can never
    // apply a policy the agent was not told about.
    const agentUserKey = studioAgentUserKey(ctx.userId)
    const designPolicy = policyArg
      ?? ctx.designPolicy
      ?? resolveProjectDesignPolicy(dir, agentUserKey)

    const { pages } = await loadStudioPages(dir)
    const { ids, unmatched } = resolveRequestedPages(pages, requested, MAX_BATCH_PAGES)
    if (ids.length === 0) {
      const known = pages.map((p) => p.title).join(', ') || '(no pages found)'
      return unmatched.length > 0
        ? toolRefusal('no-such-page', `No screen matched ${unmatched.map((n) => `"${n}"`).join(', ')}.`, {
            remedy: `This project has: ${known}.`,
          })
        : toolRefusal('no-such-page', 'This project has no screens to audit yet.', {
            remedy: 'Write the page file first, then audit it.',
          })
    }

    const pageById = new Map(pages.map((p) => [p.id, p]))

    // Built ONCE for the whole batch and reused per page — see module doc.
    const project = createWorkspaceProject(dir)
    // Design-system-package detection degrades to "none" on a probe failure —
    // the audit still runs, it just cannot check design-system adoption. The
    // token CSS degrades per source on its own (`projectTokenSources.ts`), the
    // same collection every other token reader uses.
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
    } catch (err) {
      console.error('[studio_quality_check] could not resolve the project profile:', err)
    }
    const cssSources = await collectProjectTokenCss(dir)
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
        const graded = applyDesignPolicy(findings, designPolicy)
        const bounded = graded.slice(0, MAX_FINDINGS_PER_PAGE)
        const errorCount = bounded.filter((f) => f.severity === 'error').length
        recordCleanRun(dir, agentUserKey, match.id, bounded.length, errorCount, designPolicy)
        results.push({
          ok: true,
          page: { id: match.id, title: match.title },
          filesScanned,
          rulesScanned,
          findings: bounded,
          findingCount: bounded.length,
          errorCount,
          truncated: truncated || graded.length > MAX_FINDINGS_PER_PAGE,
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

      const graded = applyDesignPolicy(findings, designPolicy)
      const bounded = graded.slice(0, MAX_FINDINGS_PER_PAGE)
      truncated = truncated || graded.length > MAX_FINDINGS_PER_PAGE
      const errorCount = bounded.filter((f) => f.severity === 'error').length
      // A9 — a clean run is the CREATIVE mode's verification, so it has to
      // outlive this process: the Stop gate reads it from a separate `bun`
      // subprocess that shares nothing with this server but the filesystem.
      // Only recorded when the page was genuinely audited (a truncated result
      // has not been fully seen and must not close a gate).
      if (!truncated) recordCleanRun(dir, agentUserKey, match.id, bounded.length, errorCount, designPolicy)

      results.push({
        ok: true,
        page: { id: match.id, title: match.title },
        filesScanned: [...filesScanned, ...sheets.map((s) => s.relPath)],
        rulesScanned,
        findings: bounded,
        findingCount: bounded.length,
        errorCount,
        truncated,
      })
    }

    return {
      ok: true,
      dir,
      // Named in every response, because a finding list only means something
      // once you know which policy produced it — an empty list under `free`
      // and an empty list under `follow` are very different claims.
      designPolicy,
      designPolicyNote: describeDesignPolicy(designPolicy),
      results,
      ...(unmatched.length > 0 ? { unmatched } : {}),
      tokensIndexed: { colorCount: tokens.colors.length, sizeCount: tokens.fontSizes.length + tokens.lengths.length },
    }
  },
}

export const studioQualityCheckMcpTools: AiTool[] = [studioQualityCheckTool]
