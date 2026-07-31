/**
 * studio_fidelity_report (WS-9.4) — the machine-readable version of "what
 * didn't import".
 *
 * Walks every loaded page's node tree and turns `PageNode.lockReason` /
 * `PageNode.resolution` / `PageNode.codeProps` into stable finding codes
 * (`./fidelityCodes.ts`), plus surfaces the project probe's own
 * `ProbeWarning`s (reused verbatim, same codes `studio_project_profile`
 * returns) as page-agnostic findings. This is the single most useful tool in
 * the studio MCP family: it is the guide an agent reads to know exactly which
 * source restructure would make a given screen import more faithfully,
 * instead of guessing from a screenshot diff alone.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { decodeSourceNodeId } from '@core/page-tree'
import type { AiTool } from '../../../runtime/types'
import { resolveProjectDir } from '../../../../handlers/studioProjects'
import { resolveProjectProfile } from '../../../../handlers/studio/projectProbe'
import { loadStudioPages } from '../../../../handlers/studioPageLoad'
import { PARSER_FIDELITY_CODES, probeWarningToFinding } from './fidelityCodes'

const MAX_FINDINGS_PER_PAGE = 100

/**
 * `PageNode.lockReason` string constants from `src/core/page-parser/parsePageFile.ts`,
 * mapped to a finding code. Order matters: checked as exact-match first, so a
 * longer/more specific reason never falls through to a looser one.
 *
 * `'one branch of several — chosen in code'` (`MULTI_BRANCH_ALL_RENDERED`) is
 * deliberately NOT in this table — `parser-06` changed the parser to SELECT
 * one branch instead of stacking every one, so that lock reason is never
 * produced anymore and the node is not locked at all. The replacement
 * finding, `BRANCH_AUTO_SELECTED`, is driven directly off
 * `PageNode.branchAlternatives` below, not off `lockReason`.
 */
const LOCK_REASON_TO_CODE: ReadonlyArray<{ reason: string; code: string }> = [
  { reason: 'dynamic — rendered in code', code: 'DYNAMIC_CONTENT_UNRESOLVED' },
  { reason: 'SVG built in code', code: 'SVG_BUILT_DYNAMICALLY' },
  { reason: 'spread props', code: 'SPREAD_PROPS_UNRESOLVED' },
]

interface Finding {
  code: string
  nodeId?: string
  file?: string
  line?: number
  message: string
  fix: string
  impact: string
}

function classifyLockReason(reason: string): string | null {
  // A resolved `.map` row's lockReason is `item N of <source>` — a SUCCESS
  // (the array itself WAS statically readable, or it wouldn't have expanded
  // into rows at all), not a limitation.
  //
  // `value from <source>` is not checked here because `lock-01` stopped the
  // parser producing it: a resolved VALUE no longer locks its node at all, so
  // the only lock reasons that reach this function are structural.
  if (/^item \d+ of /.test(reason)) return null
  const match = LOCK_REASON_TO_CODE.find((entry) => reason === entry.reason)
  return match?.code ?? null
}

function codeDefFor(code: string) {
  return PARSER_FIDELITY_CODES.find((c) => c.code === code)
}

const DirInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
    ),
    pageId: Type.Optional(Type.String({ description: 'Restrict the report to one page id (from studio_list_pages). Omit for every page.' })),
    maxFindingsPerPage: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: 'Cap on findings returned per page. Default 100; excess is summarized in findingCounts.' }),
    ),
  },
  { additionalProperties: false },
)

export const studioFidelityReportTool: AiTool = {
  name: 'studio_fidelity_report',
  scope: 'shared',
  execution: 'server',
  description:
    'The machine-readable "what will not import faithfully" report. Per page: a score (nodes/resolved/locked/codeValued) and a findings[] list, each { code, nodeId, file, line, message, fix, impact } — every documented studio-import limitation as a stable, actionable code (see docs/features/studio-import.md "What still does not import"). Also returns projectFindings from the project probe (missing Tailwind config, dependencies not installed, guessed pages dir, …) using the SAME codes studio_project_profile exposes. Call this before doing a visual audit — it tells you WHY a screen looks wrong and what source change would fix it, which a pixel diff alone cannot.',
  inputSchema: DirInputSchema,
  handler: async (input) => {
    const { dir: dirInput, pageId, maxFindingsPerPage } = input as {
      dir?: string
      pageId?: string
      maxFindingsPerPage?: number
    }
    const dir = resolveProjectDir(dirInput)
    const cap = maxFindingsPerPage ?? MAX_FINDINGS_PER_PAGE

    const profile = resolveProjectProfile(dir)
    const projectFindings = profile.warnings.map(probeWarningToFinding)

    const { pages } = await loadStudioPages(dir)
    const targetPages = pageId ? pages.filter((p) => p.id === pageId) : pages

    const pageReports = targetPages.map((page) => {
      let resolved = 0
      let locked = 0
      let codeValued = 0
      const findings: Finding[] = []
      const findingCounts: Record<string, number> = {}

      for (const [nodeId, node] of Object.entries(page.nodes)) {
        if (node.resolution) resolved += 1
        if (node.locked) locked += 1
        if (node.codeProps && node.codeProps.length > 0) codeValued += 1

        const loc = decodeSourceNodeId(nodeId)
        const locFields = loc ? { file: loc.rel, line: loc.line } : {}

        if (node.lockReason) {
          const code = classifyLockReason(node.lockReason)
          if (code) {
            findingCounts[code] = (findingCounts[code] ?? 0) + 1
            if (findings.length < cap) {
              const def = codeDefFor(code)
              findings.push({
                code,
                nodeId,
                ...locFields,
                message: `${def?.title ?? code}: ${node.lockReason}`,
                fix: def?.fix ?? 'See docs/features/studio-import.md for this finding code.',
                impact: def?.impact ?? '',
              })
            }
          }
        }

        if (node.codeProps && node.codeProps.length > 0) {
          findingCounts.CODE_VALUED_PROP = (findingCounts.CODE_VALUED_PROP ?? 0) + 1
          if (findings.length < cap) {
            const def = codeDefFor('CODE_VALUED_PROP')
            findings.push({
              code: 'CODE_VALUED_PROP',
              nodeId,
              ...locFields,
              message: `${def?.title ?? 'CODE_VALUED_PROP'}: ${node.codeProps.join(', ')} on this node has no writable source target.`,
              fix: def?.fix ?? '',
              impact: def?.impact ?? '',
            })
          }
        }

        // `node.branchAlternatives` is populated when the parser SELECTED one
        // branch of a multi-return/ternary/`&&` (parser-06) — the node itself
        // is NOT locked, but the choice is heuristic and worth surfacing.
        if (node.branchAlternatives && node.branchAlternatives.length > 0) {
          findingCounts.BRANCH_AUTO_SELECTED = (findingCounts.BRANCH_AUTO_SELECTED ?? 0) + 1
          if (findings.length < cap) {
            const def = codeDefFor('BRANCH_AUTO_SELECTED')
            const alternates = node.branchAlternatives.map((alt) => `"${alt.label}" (${alt.loc.file}:${alt.loc.line})`).join(', ')
            findings.push({
              code: 'BRANCH_AUTO_SELECTED',
              nodeId,
              ...locFields,
              message: `${def?.title ?? 'BRANCH_AUTO_SELECTED'}: chose this branch over ${node.branchAlternatives.length} alternate(s): ${alternates}.`,
              fix: def?.fix ?? '',
              impact: def?.impact ?? '',
            })
          }
        }
      }

      const nodeCount = Object.keys(page.nodes).length
      return {
        pageId: page.id,
        title: page.title,
        score: { nodes: nodeCount, resolved, locked, codeValued },
        findingCounts,
        findings,
        truncated: findings.length >= cap && Object.values(findingCounts).some((n) => n > cap),
      }
    })

    return { dir, projectFindings, pages: pageReports }
  },
}
