/**
 * agentRosterReferences — the CONTENT of the generated `.claude/*.md` reference
 * files every Studio subagent reads. Pure string builders, no roster logic and
 * no filesystem access: `agentRoster.ts` owns assembly, hashing, and the
 * never-clobber write discipline; this module only decides what the text says.
 *
 * Split out of `agentRoster.ts` (its third extraction, after
 * `agentRosterManifest.ts` and `agentRosterDocOutline.ts`) when adding
 * `design-critic`'s "measure against the design when there is one" section
 * pushed that file to 743 lines, past the 700-line ceiling
 * `module-size-budgets.test.ts` enforces. Extracted rather than grandfathered,
 * matching every other split this session.
 *
 * `referencePath` lives here, not in `agentRoster.ts`, because it is the single
 * source of truth for BOTH halves of a promise that used to be broken: where a
 * reference file is written, and where a prompt tells an agent to look for it.
 * Those two drifted once already — every prompt said "in this same `.claude/`
 * directory" while `buildReferenceFiles` wrote to the project root (see
 * `agent-02`). Keeping the path derivation next to the content, with
 * `agentRoster.ts` importing it one-directionally, is what stops that
 * recurring.
 */
import type { ProjectProfile } from './projectProfileSchema'
import { studioAgentTools } from '../../ai/tools/studio'

const CLAUDE_DIR = '.claude'

/** Project-relative POSIX path of a generated reference file — the one derivation both the write target and every prompt's pointer text use. */
export function referencePath(name: string): string {
  return `${CLAUDE_DIR}/${name}`
}

export interface ReferenceFile {
  readonly relPath: string
  readonly content: string
}

/**
 * `studio-tools.md` is GENERATED from the registry, never hand-written —
 * §7.4's own callout: a hand-written tool list is wrong the first time a
 * tool is renamed, and every agent inherits the error at once.
 */
export function studioToolsReference(): string {
  const lines = studioAgentTools
    .map((t) => `- \`${t.name}\`${t.mutates ? ' (write)' : ''} — ${t.description}`)
  return [
    '# Studio tools',
    '',
    'Generated from the live tool registry — do not hand-edit this file, it is',
    'regenerated on every chat turn and any edit here will be overwritten.',
    '',
    ...lines,
    '',
  ].join('\n')
}

export function canonicalJsxReference(): string {
  return [
    '# Canonical JSX — quick reference',
    '',
    'Full contract with examples: `docs/reference/canonical-jsx.md` in the',
    'Studio installation. This file is a compact pointer, not a substitute —',
    'read the full doc when you need the exact detection mechanism or a',
    'non-example for a specific rule.',
    '',
    'A screen is canonical when it has ZERO `violation`-tier findings — not',
    'zero findings. Three of the ten rules (`literal-props`,',
    '`static-class-name`, `no-wrapper-elements`) are `advisory` and fire on',
    'legitimate, fully-canonical code too (a CSS-Modules `styles.x` usage',
    'always trips `static-class-name`) — do not chase advisories to zero.',
    '',
    'The ten rules, one line each: one `return`; props as literals or',
    'module-scope consts; text as literal strings; `.map` only over a',
    'module-scope const array; no spread props; a static `className`/`styles.x`;',
    'one styling mechanism per file; inline `<svg>` stays static JSX;',
    'components imported directly, never through a computed specifier; no',
    'unnecessary wrapper elements added around content.',
  ].join('\n')
}

export function studioInvariantsReference(): string {
  return [
    '# Studio invariants',
    '',
    '1. Parse, never execute. Everything on the canvas was read statically out',
    '   of the AST — no component was rendered, no hook was called.',
    '2. A write must have exactly one honest target. An edit that cannot land',
    '   in exactly one place in the user\'s source is refused, not brute-forced.',
    '3. `locked` (structure) and `codeProps` (values) are different facts —',
    '   never treat one as implying the other.',
    '4. Never add a wrapper element around existing content — it breaks',
    '   `%`/flex height chains and CSS combinators in the user\'s own stylesheet.',
    '5. Trust tiers are the gate. Tier 0 runs nothing. You may ASK the user to',
    '   promote a project; you may never promote one yourself.',
    '6. `studio-workspace/` is the user\'s real project with no other copy.',
    '   There is no delete-a-project tool and none of your tools can reach one.',
  ].join('\n')
}

export function nodeIdsReference(): string {
  return [
    '# Node ids and writeback',
    '',
    'A node id IS a source location (`relFile:line:col`, or an inlined',
    'composite id). Never invent, guess, concatenate, or pattern-match one —',
    'use ids exactly as a tool returned them.',
    '',
    '`studio_apply_edits`/`studio_codemod` return `shifted: true` when a write',
    'changed a touched file\'s line count — guaranteed for insert/delete/move,',
    'likely for detach/swap, never for the six single-line value edits',
    '(prop/text/style/literal/tag/asset). After ANY `shifted: true` result,',
    'every node id you already hold is stale. Re-read before your next edit —',
    'editing with a stale id silently modifies the wrong element.',
  ].join('\n')
}

export function designPrinciplesReference(): string {
  return [
    '# Studio design principles',
    '',
    'Reviewed by design-critic — hierarchy, spacing rhythm, alignment,',
    'contrast, and state coverage (empty, error, loading), not personal taste.',
    '',
    '- Establish a clear visual hierarchy before adding detail — one primary',
    '  action per screen, not three competing ones.',
    `- Keep spacing on the project's own scale (see ${referencePath('project-conventions.md')})`,
    '  rather than inventing one-off values.',
    '- Every interactive screen needs an empty state, an error state, and a',
    '  loading state considered — even if the answer is "not applicable here".',
    '- Contrast and touch-target size are not optional polish; call them out',
    '  as findings, not suggestions, when they fail.',
    '',
    '## Responsive by default — not a follow-up pass',
    '',
    'A generated screen came back with `width: 375px` hardcoded on its root and',
    'zero media queries in 233 lines. A board frame shows one device width; that',
    'is the preview, never the specification.',
    '',
    '- **Never put a fixed pixel width on a container.** Use `width: 100%` with',
    '  a `max-width` cap, and let the frame decide the rest.',
    '- Fixed `px` belongs only on things that genuinely do not scale — icon',
    '  boxes, hairline borders, minimum touch targets.',
    '- Prefer fluid values (`clamp()`, `%`, `rem`, `minmax()`) over a breakpoint',
    '  whenever the layout can simply flex instead.',
    '- Reach for a media query when the layout must genuinely CHANGE (a row',
    '  becoming a column), not to restate a width you already hardcoded.',
    '',
    '## Use the design system before writing CSS',
    '',
    'A generated screen imported 2 components and hand-rolled a nav, a divider,',
    'and three card rows in a local CSS module — every one of which already',
    'existed in the installed design system.',
    '',
    '- **Priority order, every time: an existing component, then a design',
    '  token, then hand-written CSS.** Reaching for a CSS module before',
    '  checking what already exists is backwards, not a style choice.',
    '- **Call `studio_list_components` (or `studio_find_component` when you',
    '  already know a name or prop) BEFORE composing or styling a screen** —',
    '  not only when something looks missing. This is the exact catalog the',
    '  insert palette itself draws from, and it beats reading a package\'s own',
    '  reference file whole, which routinely runs to 100 KB+ and fails the',
    '  read-size limit outright.',
    '- **When the project has approved its own design-system MCP server**',
    '  (`.studio/meta.json`\'s `approvedMcpServers` — ask if you are unsure',
    '  one exists), prefer ITS `list_components`/`find_component` over',
    '  `studio_list_components`: it is authored by the package itself against',
    '  its own component internals, and is the better source whenever both',
    '  are available.',
    '- **An EMPTY result from `studio_list_components` is not proof there is',
    '  no design system.** It reads a package\'s own `.d.ts`/`.tsx` type',
    '  declarations only — a design system shipping bundled, untyped JS',
    '  returns zero components even though it is real and installed. Check',
    `  the response's \`designSystems\`/\`note\` fields before concluding`,
    `  anything: if one is listed, read ${referencePath('design-system.md')}`,
    '  (its own BEM class-name index) or a sibling screen\'s existing classes',
    '  instead of hand-rolling — never let a bare `[]` justify skipping the',
    '  design system.',
    '- A local CSS module is for composing and positioning the system\'s',
    '  components, not for re-implementing one of them.',
    '',
    '## Measure against the design when there is one',
    '',
    'A registered design reference turns "does this look right" from an opinion',
    'into a measurement. Prefer the measurement — and be honest about which one',
    'you actually took.',
    '',
    '- **Call `studio_list_design_references` before reviewing a screen.** A',
    '  reference may have been supplied for this page by the user (the Agent',
    '  Panel\'s "Attach design reference" control) or registered by another',
    '  agent from a Figma export.',
    '- **Match resolution by re-exporting, not by squashing the reference.**',
    '  `studio_recommend_export_dpr` gives the `dpr` that makes a fresh',
    '  `studio_export_frames` capture land on the reference\'s own pixel width.',
    '  Resampling the reference to fit instead introduces interpolation noise',
    '  in exactly the fine detail you are trying to judge.',
    '- **Read the diff\'s `method` before trusting its score.** `exact` is a',
    '  real pixel comparison. `resampled` means the reference was scaled, so',
    '  hairlines, 1px borders and text edges carry artefacts — do not report',
    '  sub-pixel differences as defects. A refusal on aspect-ratio grounds is',
    '  itself the finding: a missing section or a wrong crop, not a styling bug.',
    '- **Pair every differing region with its node ids** (`nodeRects` from the',
    '  export, echoed back by the diff). "The hero is 78% different, nodes X',
    '  and Y" is actionable; "it looks off" is not. A region matching no node',
    '  is usually background or spacing rather than a component.',
    '- **Never imply a comparison you did not make.** With no reference',
    '  registered, say so and review against the house style above. A',
    '  fabricated similarity number is worse than an honest judgement.',
  ].join('\n')
}

/** Per-project, generated from `studio_project_profile` — framework, pagesDir, styling mechanism, component packages. */
export function projectConventionsReference(dir: string, profile: ProjectProfile): string {
  const style = [
    profile.styleToolchain.cssModules ? 'css-modules' : null,
    profile.styleToolchain.sass ? 'sass' : null,
    profile.styleToolchain.tailwind ? 'tailwind' : null,
  ].filter((v): v is string => v !== null)
  return [
    '# Project conventions',
    '',
    'Generated from studio_project_profile — regenerated on every chat turn,',
    'do not hand-edit.',
    '',
    `- Project: ${dir}`,
    `- Framework: ${profile.framework}`,
    `- Pages directory: ${profile.pagesDir}`,
    `- Package manager: ${profile.packageManager}`,
    `- Styling mechanism: ${style.length > 0 ? style.join(', ') : '(none detected)'}`,
    `- Component packages: ${profile.componentPackages.length > 0 ? profile.componentPackages.join(', ') : '(none)'}`,
  ].join('\n')
}
