/**
 * fidelityCodes — the stable finding-code vocabulary `studio_fidelity_report`
 * emits (WS-9.4).
 *
 * `docs/features/studio-import.md`'s "What still does not import" section is
 * the human-authored, honest list of every deliberate parser limitation. This
 * module is that same list turned into a machine-readable contract: one entry
 * per finding a `studio_fidelity_report` call can actually emit, each with a
 * stable `code`, a short human title, the message template, a suggested
 * source restructure (`fix`), and the typical `impact`.
 *
 * Two families:
 *   - **Probe-level codes** are NOT minted here — they are `ProbeWarning.code`
 *     values already shipped in `projectProfileSchema.ts` (see that file's own
 *     doc comment: "WS-9 turns these into MCP fidelity findings ... once a
 *     code has shipped it is a contract"). Reusing them means a project-level
 *     issue (no Tailwind config, dependencies not installed, …) reads under
 *     the SAME code whether it surfaces from `studio_project_profile` or from
 *     `studio_fidelity_report` — one vocabulary, not two that drift.
 *   - **Parser-level codes** (`PARSER_FINDING_CODES` below) are minted here
 *     because they classify a NODE's `lockReason`/`codeProps`, which the probe
 *     never sees — the probe runs before any page is parsed.
 *
 * `fidelityCodes.test.ts` gates doc ⇄ code parity: every code below must
 * appear in the doc table, and every code cell in the doc table must appear
 * here (and, for probe codes, in `projectProfileSchema.ts`'s own emitted set).
 *
 * Renaming a code once it has shipped is a breaking change for whatever is
 * keying off it — add a new code and deprecate the old one in prose instead.
 */
import type { ProbeWarning } from '../../../../handlers/studio/projectProfileSchema'

export type FidelitySeverity = 'error' | 'warning' | 'info'

export interface FidelityCodeDef {
  code: string
  title: string
  severity: FidelitySeverity
  /** What this finding means, in general terms — the per-finding `message` adds the specific node/file. */
  description: string
  /** A suggested source restructure that would make this resolve. */
  fix: string
  /** Typical cost of leaving it as-is. */
  impact: string
}

/**
 * Probe-level codes, reused verbatim from `ProjectProfile.warnings[].code`.
 * This list exists only so the doc-parity test can enumerate "every code the
 * probe can emit" without importing the probe's internals — it is NOT a
 * second definition of what the code means (the probe's own `message`/`fix`
 * strings at the call site are the source of truth for wording; these are
 * the same short titles used in the doc table).
 */
export const PROBE_FIDELITY_CODES: readonly FidelityCodeDef[] = [
  {
    code: 'next-config-no-routes-found',
    title: 'Next.js config found, but no routes discovered',
    severity: 'error',
    description: 'A next.config.* was detected but no page.tsx/page.jsx route could be discovered under the app directory.',
    fix: 'Confirm the App Router directory is named `app/` (or set `pagesDir` in .studio/meta.json) and that at least one route has a page.tsx.',
    impact: 'The project has zero frames on the board.',
  },
  {
    code: 'vite-entry-not-found',
    title: 'Vite entry not found',
    severity: 'warning',
    description: 'A vite.config.* was detected but its declared entry file does not exist on disk.',
    fix: 'Point vite.config at a real entry, or set pagesDir explicitly.',
    impact: 'Style/entry-point collection may miss global CSS.',
  },
  {
    code: 'tailwind-config-not-found',
    title: 'Tailwind detected, no config file',
    severity: 'warning',
    description: 'A tailwind dependency is declared but no tailwind.config.* (v3) or CSS @import "tailwindcss" entry (v4) was found.',
    fix: 'Add the project\'s real tailwind config to the imported tree, or confirm the entry CSS file is included in the workspace.',
    impact: 'Tailwind utility classes never compile — the board renders unstyled.',
  },
  {
    code: 'dependencies-not-installed',
    title: 'Dependencies not installed',
    severity: 'warning',
    description: 'package.json declares dependencies but node_modules is missing or incomplete.',
    fix: 'Call studio_install_deps and poll studio_install_status before relying on package CSS, package components, or `?raw` package-icon imports.',
    impact: 'Package CSS, package components, and Tailwind/PostCSS all silently resolve to nothing.',
  },
  {
    code: 'pages-dir-heuristic',
    title: 'Pages directory guessed, not detected',
    severity: 'info',
    description: 'No framework convention named a pages directory; the probe ranked candidate directories by (files whose default export returns JSX) / (total code files) and picked the top one.',
    fix: 'Set pagesDir explicitly in .studio/meta.json if the guess is wrong — studio_project_profile.pagesDirCandidates lists the runner-ups.',
    impact: 'Wrong directory guessed → wrong or missing pages on the board.',
  },
  {
    code: 'pages-dir-not-found',
    title: 'Pages directory not found',
    severity: 'error',
    description: 'Neither a framework convention nor the heuristic found any directory of page-shaped files.',
    fix: 'Set pagesDir explicitly in .studio/meta.json to the directory containing the app\'s screens.',
    impact: 'The project has zero frames on the board.',
  },
]

/**
 * Parser-level codes: derived from a `PageNode`'s own `lockReason`/`resolution`/
 * `codeProps` fields while walking a loaded page tree. Each maps 1:1 to one of
 * `parsePageFile.ts`'s lock-reason constants (see that file — `DYNAMIC_LOCK_REASON`,
 * `SPREAD_LOCK_REASON`, `DYNAMIC_SVG_LOCK_REASON`, `BRANCH_LOCK_REASON`) or to
 * `PageNode.codeProps` directly.
 */
export const PARSER_FIDELITY_CODES: readonly FidelityCodeDef[] = [
  {
    code: 'DYNAMIC_CONTENT_UNRESOLVED',
    title: 'Node content is rendered dynamically, in code',
    severity: 'warning',
    description:
      'The parser could not statically resolve what this node renders — a `.map` over data reached through props/state/fetch, an image behind hook state, a computed `className` interpolation with no resolvable value, or a CSS-in-JS-styled element. The node still appears on the board, but its content is fixed and cannot be edited.',
    fix: 'Move the underlying data to a module-scope const (`const PLANS = […]`) and map/reference it directly, or pass it as a literal default prop, so the evaluator can read it without running any code.',
    impact: 'One opaque, unstyled-or-frozen node instead of the real (often multi-row) content.',
  },
  {
    code: 'SVG_BUILT_DYNAMICALLY',
    title: 'SVG markup is constructed in code',
    severity: 'warning',
    description: 'An inline <svg> whose markup depends on a prop, state, or a loop the evaluator cannot run — the graphic cannot be serialized.',
    fix: 'Author the SVG as a static `?raw` import, or move any variable geometry into an editable prop the evaluator can read (e.g. a literal `strokeDashoffset` default).',
    impact: 'The node renders empty or as a placeholder box instead of the real icon/graphic.',
  },
  {
    code: 'SPREAD_PROPS_UNRESOLVED',
    title: 'Element uses spread props',
    severity: 'info',
    description: '`<div {...rest}/>` — the parser cannot enumerate which attributes actually land on the element without running the spread.',
    fix: 'Destructure the specific props the element needs instead of spreading an arbitrary rest object.',
    impact: 'The node and its descendants are structurally locked (selectable, not editable).',
  },
  {
    code: 'BRANCH_AUTO_SELECTED',
    title: 'One branch of a conditional was auto-selected',
    severity: 'info',
    description: 'The parser found more than one JSX-bearing `return`, or a ternary/`&&`, and rendered the heuristically-chosen branch (the last unconditional `return`; a ternary\'s consequent; `&&`\'s body) — never all of them stacked. The untaken alternative(s) are recorded (label + source location) but not rendered; a statically-resolvable condition (a literal, a module-scope const) always wins over the heuristic. This is informational, not a defect: the node is NOT locked, only the choice is heuristic.',
    fix: 'If the auto-selected branch is wrong for this audit, open `studio_get_node_source` on the alternative\'s location to see what would render instead — evaluating the condition to switch branches is Tier D (never done). Split the branches into separate named components/files if they are genuinely different screens.',
    impact: 'One node instead of N — verify against a real run of the app (studio_render_reference) if the chosen branch matters for the audit.',
  },
  {
    code: 'CODE_VALUED_PROP',
    title: 'One or more props on this node are code-valued',
    severity: 'info',
    description: 'A specific prop (not the whole node) resolved from an expression rather than a literal — writing an edit back would replace the expression that produces it, so that prop stays read-only while its literal siblings remain editable.',
    fix: 'If this prop should be editable, change its call-site value to a literal, or extract it to a named constant the evaluator can resolve and treat as content.',
    impact: 'Named in codeProps — the Properties panel shows those specific fields as read-only.',
  },
  {
    code: 'RTL_PHYSICAL_PROPERTY',
    title: 'Style uses a physical (not logical) direction property',
    severity: 'info',
    description: 'This node\'s style rules declare a physical-direction property (`margin-left`/`padding-right`/`left`/`right`/`text-align: left`/…) rather than a logical one (`margin-inline-start`, `inset-inline-end`, `text-align: start`, …). WS-10\'s RTL preview does not correct this — it is a real, honest finding: a project written with physical properties LOOKS WRONG in RTL because it IS wrong in RTL.',
    fix: 'Replace the physical property with its logical equivalent (`margin-left` → `margin-inline-start`, `text-align: left` → `text-align: start`, …) so the layout mirrors correctly under `dir="rtl"`.',
    impact: 'Spacing/alignment does not mirror when this page is previewed (or shipped) right-to-left.',
  },
]

export const ALL_FIDELITY_CODES: readonly FidelityCodeDef[] = [
  ...PROBE_FIDELITY_CODES,
  ...PARSER_FIDELITY_CODES,
]

const CODE_BY_ID = new Map(ALL_FIDELITY_CODES.map((c) => [c.code, c]))

export function fidelityCodeDef(code: string): FidelityCodeDef | undefined {
  return CODE_BY_ID.get(code)
}

/** Turn a probe warning (already `{ code, message, fix }`) into a page-agnostic finding entry — reused verbatim, never re-worded. */
export function probeWarningToFinding(warning: ProbeWarning): {
  code: string
  message: string
  fix: string
} {
  return { code: warning.code, message: warning.message, fix: warning.fix }
}
