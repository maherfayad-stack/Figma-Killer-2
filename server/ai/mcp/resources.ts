/**
 * MCP resources — static, read-only reference content an agent fetches once
 * and keeps in context, distinct from a tool call (which does work).
 *
 * `studio://guidelines` (WS-9.5) is the distilled "how to write React that
 * imports cleanly" rule set: module-scope consts over hooks for demo data,
 * literal `className`s, avoid computed variants, one return per component
 * where possible, `?raw` icon imports, providers kept in one place. Reading
 * it once and writing conformant code thereafter is the requirement's
 * "guiding it on how to structure the pages so they render perfectly".
 *
 * The content here is a direct distillation of `docs/features/studio-import.md`
 * §"What still does not import" — each rule below exists because a
 * corresponding `studio_fidelity_report` finding code exists for the
 * violation. Keep the two in sync: a new finding code that names a pattern to
 * avoid should get a rule here too.
 */

export interface McpResourceDef {
  uri: string
  name: string
  description: string
  mimeType: string
  text: string
}

const STUDIO_GUIDELINES_TEXT = `# Writing React that Studio can import faithfully

Studio parses your source statically — it never executes your code (no
component render, no hook call). Every value on the board was read directly
out of the AST by a bounded evaluator. These rules are exactly the difference
between a screen that imports as real, editable content and one that imports
as a single locked, opaque node.

## 1. Demo/seed data: module-scope consts, not hook state

\`const PLANS = [{ name: 'Basic', price: 9 }, …]\` at the top of the file
resolves. \`useState(() => fetchPlans())\` or a value read from \`useQuery\`
does not — the evaluator cannot run a fetch or a hook. If a list is meant to
render real rows on the board, keep its literal shape reachable as a
module-scope constant, even if the component also supports fetching live data
at runtime.

Finding code if this fails: \`DYNAMIC_CONTENT_UNRESOLVED\`.

## 2. \`className\`: literal strings over computed interpolation

\`className="card card--primary"\` always resolves. A CSS Module import
(\`styles.card\`) or a \`cn()\`/\`clsx()\`/\`classnames()\` call over resolvable
inputs also resolves. A template literal whose interpolation depends on
component state or an unresolvable prop — e.g. a variant suffix interpolated
from a value that comes from \`useState\` — keeps only its static prefix; the
variant class never attaches.

Finding code if this fails: \`DYNAMIC_CONTENT_UNRESOLVED\` (or, for a package
manifest, a missing enum control).

## 3. One \`return\` per component where possible

When a component has more than one JSX-bearing \`return\`, or a ternary/\`&&\`,
the parser SELECTS one branch (the last unconditional \`return\`; a ternary's
consequent; \`&&\`'s body) instead of rendering every branch stacked —
evaluating the condition to pick a branch would require executing code, which
never happens. The node is not locked, but the choice is a heuristic, not a
guarantee it matches what a real user sees; the untaken alternative(s) are
recorded, not rendered. If a component is genuinely a multi-stage flow,
prefer one component per stage (one file, one \`return\`) over a single
component with internal branching, so every stage is its own real screen
instead of a heuristic pick.

Finding code: \`BRANCH_AUTO_SELECTED\` (info, not a defect).

## 4. Icons and inline SVG: \`?raw\` imports, not props/state-driven markup

\`import IconRaw from './icon.svg?raw'\` resolves to real, editable markup.
An \`<svg>\` whose \`d\`/\`stroke-dashoffset\`/children depend on a prop or piece
of state does not serialize — the graphic renders empty or as a placeholder.

Finding code if this fails: \`SVG_BUILT_DYNAMICALLY\`.

## 5. Avoid spreading arbitrary prop bags onto elements

\`<div {...rest}/>\` cannot be statically enumerated — the parser cannot know
which attributes actually land without running the spread. Destructure the
specific props an element needs instead.

Finding code if this fails: \`SPREAD_PROPS_UNRESOLVED\`.

## 6. Keep providers (theme, design-system context) in one place

A design-system \`<ThemeProvider>\`/context should wrap the app once, near the
root, rather than being re-instantiated per screen with different literal
config. This keeps every screen's rendered output consistent and makes the
provider's own config resolvable in one place instead of N.

## 7. Prefer literal prop values over computed ones at the call site

\`<Icon size={24}/>\` is editable. \`<Icon size={isCompact ? 16 : 24}/>\` is not
— that specific prop becomes \`codeProps\`-locked (read-only) while its literal
siblings stay editable.

Finding code if this fails: \`CODE_VALUED_PROP\`.

## 8. CSS: prefer plain CSS, CSS Modules, or Tailwind over CSS-in-JS

Plain \`.css\` imports and CSS Modules (\`.module.css\`) compile and resolve
through the evaluator. Tailwind compiles through the project's own toolchain
once the project is promoted past Tier 0. \`styled-components\`/\`emotion\`/
\`stitches\` are detected but never compiled — a component styled this way
renders structurally correct and completely unstyled.

## Before you rely on any of this: call studio_fidelity_report

\`studio_project_profile\` tells you what toolchain/framework was detected;
\`studio_fidelity_report(dir, pageId?)\` tells you, per screen, exactly which
node violates which rule above, with a suggested fix and the file:line to go
fix it. Read the report before guessing from a screenshot diff alone.
`

export const MCP_RESOURCES: readonly McpResourceDef[] = [
  {
    uri: 'studio://guidelines',
    name: 'Studio import guidelines',
    description:
      'How to write React that Studio\'s static parser imports faithfully — module-scope data, literal classNames, one return per component, ?raw icon imports, provider placement. Read once, write conformant code thereafter.',
    mimeType: 'text/markdown',
    text: STUDIO_GUIDELINES_TEXT,
  },
]

export function findMcpResource(uri: string): McpResourceDef | undefined {
  return MCP_RESOURCES.find((r) => r.uri === uri)
}
